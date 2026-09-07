"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  PARENT_LANGUAGE,
  QUESTIONS,
  languageLabel,
  type Question,
} from "@/lib/conversation-mode";
import {
  QUESTIONNAIRE_PLAY_AGENT,
  QUESTIONNAIRE_REPLY_AGENT,
  MIN_ANSWER_SAMPLES,
  REPLY_MAX_WAIT_MS,
  REPLY_QUIET_MS,
  buildPlayAgentPrompt,
  buildReplyLanguageHint,
  languageNameForPrompt,
  normalizePlayTranslation,
} from "@/lib/questionnaire/constants";
import {
  concatInt16,
  connectLiveSocket,
  disconnectLive,
  endTurn,
  extractStructured,
  getPcmPlayerWorkletUrl,
  getPcmRecorderWorkletUrl,
  hasUsableReply,
  isSocketOpen,
  joinReplyText,
  mintQuestionnaireLiveSession,
  parseLiveEvent,
  pcmRms,
  resamplePcm16,
  sendPcm,
  sendRecordedPcmStream,
  sendText,
  sendTrailingSilence,
  shouldAcceptReplyEvent,
  silentPcmChunk,
  sleep,
  startTurn,
  TARGET_PCM_SAMPLE_RATE,
  type LiveSessionInfo,
  type ReplyStructured,
} from "@/lib/questionnaire/live-client";

export function useQuestionnaireFlow() {
  const playAbortRef = useRef<AbortController | null>(null);
  const playEpochRef = useRef(0);
  const playTurnActiveRef = useRef(false);
  /** True after Skip/interrupt until turn_complete (or timeout) on the play WS. */
  const playDrainNeededRef = useRef(false);
  /** Shared drain so Skip can return immediately while playQuestion awaits the same mark. */
  const playDrainPromiseRef = useRef<Promise<void> | null>(null);
  const audioWsRef = useRef<WebSocket | null>(null);
  const audioSessionRef = useRef<LiveSessionInfo | null>(null);
  const replyWsRef = useRef<WebSocket | null>(null);
  const replySessionRef = useRef<LiveSessionInfo | null>(null);
  /** Question index this reply WS belongs to; reused for no-speech / replay. */
  const replyQuestionIndexRef = useRef<number | null>(null);
  const replyConnectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  const playerCtxRef = useRef<AudioContext | null>(null);
  const playerNodeRef = useRef<AudioWorkletNode | null>(null);
  const recCtxRef = useRef<AudioContext | null>(null);
  const recNodeRef = useRef<AudioWorkletNode | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recSampleRateRef = useRef(TARGET_PCM_SAMPLE_RATE);
  const pcmPartsRef = useRef<Int16Array[]>([]);
  const replySegmentsRef = useRef<ReplyStructured[]>([]);
  const replyStructuredRef = useRef<ReplyStructured | null>(null);
  const replyAbortRef = useRef(false);
  const replyTurnEndedRef = useRef(false);
  /** Block mic while a question is playing (avoid question audio as input). */
  const replyInputBlockedRef = useRef(false);
  const recordingPausedRef = useRef(false);
  const liveStreamActiveRef = useRef(false);

  const ensurePlayer = useCallback(async () => {
    if (playerNodeRef.current && playerCtxRef.current?.state !== "closed") {
      return;
    }

    playerNodeRef.current?.disconnect();
    playerNodeRef.current = null;
    if (playerCtxRef.current && playerCtxRef.current.state !== "closed") {
      void playerCtxRef.current.close().catch(() => {});
    }
    playerCtxRef.current = null;

    playerCtxRef.current = new AudioContext({ sampleRate: 24000 });
    await playerCtxRef.current.audioWorklet.addModule(getPcmPlayerWorkletUrl());
    playerNodeRef.current = new AudioWorkletNode(
      playerCtxRef.current,
      "pcm-player-processor"
    );
    playerNodeRef.current.connect(playerCtxRef.current.destination);
    await playerCtxRef.current.resume();
  }, []);

  const notifyPlaySettled = useCallback(() => {
    playTurnActiveRef.current = false;
  }, []);

  /**
   * Wait until the play agent signals the interrupted turn is done
   * (turn_complete / end) — the mark that it is safe to start the next question
   * on the same WebSocket. Idempotent: concurrent callers share one promise.
   */
  const ensurePlayDrain = useCallback((ws: WebSocket): Promise<void> => {
    if (playDrainPromiseRef.current) {
      return playDrainPromiseRef.current;
    }

    playDrainPromiseRef.current = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws.removeEventListener("message", onDrainMessage);
        playTurnActiveRef.current = false;
        playDrainNeededRef.current = false;
        playDrainPromiseRef.current = null;
        if (playerNodeRef.current) {
          playerNodeRef.current.port.postMessage({ command: "reset" });
        }
        resolve();
      };

      const onDrainMessage = (event: MessageEvent) => {
        // Drop leftover TTS while draining so it cannot reach the next play.
        if (typeof event.data !== "string") {
          if (playerNodeRef.current) {
            playerNodeRef.current.port.postMessage({ command: "reset" });
          }
          return;
        }
        try {
          const frame = JSON.parse(event.data) as {
            type?: string;
            finished?: boolean;
          };
          if (
            frame.type === "turn_complete" ||
            frame.type === "end" ||
            frame.finished === true
          ) {
            finish();
          }
        } catch {
          // ignore non-JSON
        }
      };

      ws.addEventListener("message", onDrainMessage);
      // Safety net if the agent never emits the completion mark.
      const timer = setTimeout(finish, 1200);
    });

    return playDrainPromiseRef.current;
  }, []);

  /**
   * Stop local playback.
   * - settle:false (Skip): instant silence, send end, drain in background, keep WS.
   * - settle:true (before next play): await turn_complete mark, then reuse same WS.
   */
  const cancelPlay = useCallback(
    async (options?: { settle?: boolean }) => {
      const wasActive =
        playTurnActiveRef.current ||
        !!playAbortRef.current ||
        playDrainNeededRef.current;
      const ws = audioWsRef.current;
      const settle = options?.settle !== false;

      // Silence immediately, before waiting on the agent.
      if (playerNodeRef.current) {
        playerNodeRef.current.port.postMessage({ command: "reset" });
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }

      // Attach drain + send end BEFORE bumping epoch so we do not miss turn_complete.
      if (wasActive && isSocketOpen(ws) && !playDrainNeededRef.current) {
        try {
          endTurn(ws!);
        } catch {
          // ignore
        }
        playDrainNeededRef.current = true;
        void ensurePlayDrain(ws!);
      }

      playEpochRef.current += 1;
      playAbortRef.current?.abort();
      playAbortRef.current = null;

      if (!settle) {
        // UI can advance immediately; playQuestion will await the same drain.
        return;
      }

      if (playDrainNeededRef.current && isSocketOpen(ws)) {
        await ensurePlayDrain(ws!);
        return;
      }

      playTurnActiveRef.current = false;
      playDrainNeededRef.current = false;
    },
    [ensurePlayDrain]
  );

  const ensureAudioLive = useCallback(async (agentSlug: string) => {
    if (isSocketOpen(audioWsRef.current) && audioSessionRef.current) {
      return audioWsRef.current!;
    }

    disconnectLive(audioWsRef.current);
    audioWsRef.current = null;

    const session = await mintQuestionnaireLiveSession(agentSlug);
    audioSessionRef.current = session;
    const ws = await connectLiveSocket(session);
    audioWsRef.current = ws;
    ws.addEventListener("close", () => {
      if (audioWsRef.current === ws) {
        audioWsRef.current = null;
      }
    });
    return ws;
  }, []);

  const rememberReplySegment = useCallback((found: ReplyStructured) => {
    if (!hasUsableReply(found)) return;
    const last = replySegmentsRef.current[replySegmentsRef.current.length - 1];
    if (last && last.original === found.original && last.english === found.english) {
      return;
    }
    replySegmentsRef.current.push(found);
    replyStructuredRef.current = replySegmentsRef.current.reduce(
      (acc, seg) => ({
        original: joinReplyText(acc.original, seg.original),
        english: joinReplyText(acc.english, seg.english),
        language: seg.language || acc.language,
      }),
      { original: "", english: "", language: "" }
    );
  }, []);

  const handleReplyEvent = useCallback(
    (parsed: Record<string, unknown>) => {
      if (
        parsed.type === "end" ||
        parsed.type === "turn_complete" ||
        parsed.finished === true
      ) {
        replyTurnEndedRef.current = true;
      }

      const found = extractStructured(parsed);
      if (found && shouldAcceptReplyEvent(parsed)) {
        rememberReplySegment(found);
      }
    },
    [rememberReplySegment]
  );

  const attachReplySocketHandlers = useCallback(
    (ws: WebSocket) => {
      const onMessage = (event: MessageEvent) => {
        void (async () => {
          let payload: string | ArrayBuffer = event.data;
          if (payload instanceof Blob) {
            payload = await payload.arrayBuffer();
          }
          const parsed = parseLiveEvent(payload);
          if (parsed.binary) return;
          handleReplyEvent(parsed as Record<string, unknown>);
        })();
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", () => {
        ws.removeEventListener("message", onMessage);
        if (replyWsRef.current === ws) {
          replyWsRef.current = null;
        }
      });
    },
    [handleReplyEvent]
  );

  /** Close reply-agent session (Next / Skip / complete / unmount). */
  const stopQuestionnaireReplySession = useCallback(() => {
    replyInputBlockedRef.current = false;
    recordingPausedRef.current = false;
    liveStreamActiveRef.current = false;
    replyConnectPromiseRef.current = null;
    replyQuestionIndexRef.current = null;
    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;
    replySessionRef.current = null;
  }, []);

  /**
   * Ensure a reply-agent live WS for this question.
   * - Same question (no-speech retry / replay): reuse open session.
   * - New question: mint a fresh session and connect (no session_id reuse).
   */
  const ensureReplySessionForQuestion = useCallback(
    async (questionIndex: number): Promise<WebSocket> => {
      if (
        replyQuestionIndexRef.current === questionIndex &&
        isSocketOpen(replyWsRef.current) &&
        replySessionRef.current
      ) {
        return replyWsRef.current!;
      }

      if (
        replyQuestionIndexRef.current === questionIndex &&
        replyConnectPromiseRef.current
      ) {
        return replyConnectPromiseRef.current;
      }

      // Different question (or missing) — close previous session.
      disconnectLive(replyWsRef.current);
      replyWsRef.current = null;
      replySessionRef.current = null;
      replyQuestionIndexRef.current = questionIndex;

      const connectPromise = (async () => {
        const session = await mintQuestionnaireLiveSession(QUESTIONNAIRE_REPLY_AGENT);
        if (replyQuestionIndexRef.current !== questionIndex) {
          throw new Error("Reply session aborted for newer question");
        }
        replySessionRef.current = session;
        const ws = await connectLiveSocket(session);
        if (replyQuestionIndexRef.current !== questionIndex) {
          disconnectLive(ws);
          throw new Error("Reply session aborted for newer question");
        }
        replyWsRef.current = ws;
        attachReplySocketHandlers(ws);
        return ws;
      })();

      replyConnectPromiseRef.current = connectPromise;
      try {
        return await connectPromise;
      } finally {
        if (replyConnectPromiseRef.current === connectPromise) {
          replyConnectPromiseRef.current = null;
        }
      }
    },
    [attachReplySocketHandlers]
  );

  const setReplyInputBlocked = useCallback((blocked: boolean) => {
    replyInputBlockedRef.current = blocked;
  }, []);

  const playViaAgent = useCallback(
    async (
      question: Question,
      language: string,
      signal: AbortSignal,
      onTranslatedText?: (text: string) => void
    ): Promise<string> => {
      const abortIfNeeded = () => {
        if (signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
      };

      await ensurePlayer();
      abortIfNeeded();
      playerNodeRef.current?.port.postMessage({ command: "reset" });

      const prompt = buildPlayAgentPrompt(
        languageNameForPrompt(language, languageLabel(language)),
        question.text_en
      );

      const ws = await ensureAudioLive(QUESTIONNAIRE_PLAY_AGENT);
      abortIfNeeded();

      let translatedText = language === PARENT_LANGUAGE ? question.text_en : "";
      const myEpoch = playEpochRef.current;
      let heardOutput = false;
      // Ignore any stray frames until we have sent THIS question's prompt.
      let turnStarted = false;

      playTurnActiveRef.current = true;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => finishResolve(), 25000);

        const finishResolve = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          ws.removeEventListener("message", onMessage);
          notifyPlaySettled();
          resolve();
        };

        const finishReject = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          ws.removeEventListener("message", onMessage);
          // Keep playTurnActive true so cancelPlay can drain the interrupted turn
          // when the socket is still open; soft-cancel clears it after disconnect.
          if (!signal.aborted) {
            notifyPlaySettled();
          }
          reject(error);
        };

        const isCurrent = () =>
          !signal.aborted && playEpochRef.current === myEpoch;

        const onMessage = (event: MessageEvent) => {
          if (!isCurrent() || !turnStarted) {
            return;
          }

          void (async () => {
            let payload: string | ArrayBuffer = event.data;
            if (payload instanceof Blob) {
              payload = await payload.arrayBuffer();
            }
            if (!isCurrent() || !turnStarted) return;

            const parsed = parseLiveEvent(payload);
            if (parsed.binary && playerNodeRef.current) {
              heardOutput = true;
              playerNodeRef.current.port.postMessage(parsed.binary, [parsed.binary]);
              return;
            }

            if (
              parsed.type === "data" &&
              parsed.modality === "text" &&
              parsed.partial !== true &&
              typeof parsed.content === "string"
            ) {
              const text = normalizePlayTranslation(parsed.content);
              const source = parsed.source || "";
              if (
                text &&
                source !== "input_transcription" &&
                (source === "output" || source === "output_transcription" || !source)
              ) {
                // Prefer the cleaner/longer translation if multiple text frames arrive.
                if (
                  translatedText &&
                  source === "output_transcription" &&
                  translatedText.length >= text.length
                ) {
                  heardOutput = true;
                  return;
                }
                heardOutput = true;
                translatedText = text;
                onTranslatedText?.(text);
              }
            }

            if (
              parsed.type === "turn_complete" ||
              parsed.type === "end" ||
              parsed.finished === true
            ) {
              // Late end from a skipped turn can arrive before this turn's audio.
              // Ignore until we have heard output for THIS play.
              if (!heardOutput) return;
              finishResolve();
            }
          })();
        };

        if (signal.aborted || playEpochRef.current !== myEpoch) {
          finishReject(new DOMException("Aborted", "AbortError"));
          return;
        }

        ws.addEventListener("message", onMessage);
        startTurn(ws, "text");
        sendText(ws, prompt);
        endTurn(ws);
        turnStarted = true;

        signal.addEventListener(
          "abort",
          () => {
            finishReject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });

      return translatedText;
    },
    [ensureAudioLive, ensurePlayer, notifyPlaySettled]
  );

  const playQuestion = useCallback(
    async (
      questionIndex: number,
      language: string,
      options?: { onTranslatedText?: (text: string) => void }
    ): Promise<{ translatedText: string }> => {
      const question = QUESTIONS[questionIndex];
      if (!question) {
        throw new Error("Question not found");
      }

      // Settle any in-flight play so a late end cannot stop this question.
      const epochBeforeSettle = playEpochRef.current;
      await cancelPlay({ settle: true });
      // Another skip/cancel raced us during settle — do not start stale audio.
      if (playEpochRef.current !== epochBeforeSettle + 1) {
        throw new DOMException("Aborted", "AbortError");
      }
      setReplyInputBlocked(true);

      // Open reply-agent session while question audio plays so Record
      // can stream immediately (reuse if same question / no-speech).
      void ensureReplySessionForQuestion(questionIndex).catch(() => {
        // Best effort; startRecording will retry.
      });

      const controller = new AbortController();
      playAbortRef.current = controller;
      playEpochRef.current += 1;

      let translatedText = "";
      const notifyTranslation = (text: string) => {
        if (!text.trim()) return;
        translatedText = text;
        options?.onTranslatedText?.(text);
      };

      try {
        translatedText = await playViaAgent(
          question,
          language,
          controller.signal,
          notifyTranslation
        );
      } finally {
        if (playAbortRef.current === controller) {
          playAbortRef.current = null;
        }
        setReplyInputBlocked(false);
      }

      return { translatedText };
    },
    [cancelPlay, ensureReplySessionForQuestion, playViaAgent, setReplyInputBlocked]
  );

  const stopMic = useCallback(() => {
    recNodeRef.current?.disconnect();
    recNodeRef.current = null;
    recStreamRef.current?.getTracks().forEach((track) => track.stop());
    recStreamRef.current = null;
    const recCtx = recCtxRef.current;
    recCtxRef.current = null;
    if (recCtx && recCtx.state !== "closed") {
      void recCtx.close().catch(() => {
        // Already closed (Strict Mode / overlapping stop).
      });
    }
  }, []);

  /**
   * Start recording with live streaming to the reply-agent WebSocket.
   * Session should already be open from playQuestion; we only start the
   * audio turn and stream. PCM is also buffered for fallback resend.
   */
  const startRecording = useCallback(
    async (questionIndex: number) => {
      await cancelPlay({ settle: true });
      setReplyInputBlocked(false);
      recordingPausedRef.current = false;
      pcmPartsRef.current = [];
      liveStreamActiveRef.current = false;

      replyStructuredRef.current = null;
      replySegmentsRef.current = [];
      replyAbortRef.current = false;
      replyTurnEndedRef.current = false;

      recStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      recCtxRef.current = new AudioContext({
        sampleRate: TARGET_PCM_SAMPLE_RATE,
        latencyHint: "interactive",
      });
      recSampleRateRef.current = recCtxRef.current.sampleRate;
      await recCtxRef.current.audioWorklet.addModule(getPcmRecorderWorkletUrl());
      recNodeRef.current = new AudioWorkletNode(recCtxRef.current, "pcm-recorder-processor");
      const source = recCtxRef.current.createMediaStreamSource(recStreamRef.current);
      source.connect(recNodeRef.current);
      const silentGain = recCtxRef.current.createGain();
      silentGain.gain.value = 0;
      recNodeRef.current.connect(silentGain);
      silentGain.connect(recCtxRef.current.destination);

      try {
        const replyWs = await ensureReplySessionForQuestion(questionIndex);
        if (isSocketOpen(replyWs)) {
          startTurn(replyWs, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
          sendPcm(replyWs, silentPcmChunk());
          liveStreamActiveRef.current = true;
        }
      } catch {
        liveStreamActiveRef.current = false;
      }

      recNodeRef.current.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer) || recordingPausedRef.current) return;
        const raw = new Int16Array(event.data.slice(0));
        const chunk =
          recSampleRateRef.current !== TARGET_PCM_SAMPLE_RATE
            ? resamplePcm16(raw, recSampleRateRef.current, TARGET_PCM_SAMPLE_RATE)
            : raw;
        pcmPartsRef.current.push(chunk as Int16Array);

        if (liveStreamActiveRef.current && isSocketOpen(replyWsRef.current)) {
          try {
            sendPcm(replyWsRef.current!, chunk as Int16Array);
          } catch {
            liveStreamActiveRef.current = false;
          }
        }
      };
      if (recCtxRef.current.state === "suspended") {
        await recCtxRef.current.resume();
      }
    },
    [cancelPlay, ensureReplySessionForQuestion, setReplyInputBlocked]
  );

  const setAnswerRecordingPaused = useCallback((paused: boolean) => {
    recordingPausedRef.current = paused;
  }, []);

  const waitForReplyQuiet = useCallback(async (): Promise<ReplyStructured | null> => {
    const started = Date.now();
    let lastCount = replySegmentsRef.current.length;
    let lastChange = Date.now();
    let turnEndedAt: number | null = null;

    while (Date.now() - started < REPLY_MAX_WAIT_MS) {
      if (replyAbortRef.current) break;

      if (replyTurnEndedRef.current && turnEndedAt === null) {
        turnEndedAt = Date.now();
      }

      if (replySegmentsRef.current.length !== lastCount) {
        lastCount = replySegmentsRef.current.length;
        lastChange = Date.now();
      }

      if (hasUsableReply(replyStructuredRef.current) && Date.now() - lastChange >= REPLY_QUIET_MS) {
        break;
      }

      if (
        turnEndedAt !== null &&
        hasUsableReply(replyStructuredRef.current) &&
        Date.now() - turnEndedAt >= 400
      ) {
        break;
      }

      if (turnEndedAt !== null && Date.now() - turnEndedAt >= 2500) {
        break;
      }

      await sleep(80);
    }

    return replyStructuredRef.current;
  }, []);

  /**
   * Stop local recording, end the live audio turn (or fallback-send full
   * buffer), and wait for transcription. Keeps the reply session open so a
   * no-speech retry can reuse it.
   *
   * Before trailing silence / endTurn, send a language hint so the reply
   * agent transcribes in native script (e.g. Telugu) instead of Latin
   * transliteration.
   */
  const stopRecordingAndTranscribe = useCallback(
    async (
      questionIndex: number,
      language: string
    ): Promise<ReplyStructured | null> => {
      recordingPausedRef.current = false;
      stopMic();

      // Keep silence/pauses intact so the agent can detect ~0.8s quiet.
      const pcm = concatInt16(pcmPartsRef.current);

      if (pcm.length < MIN_ANSWER_SAMPLES) {
        throw new Error("Recording too short. Speak longer, then stop.");
      }

      if (pcmRms(pcm) < 180) {
        throw new Error("Could not detect speech in the recording. Speak louder and try again.");
      }

      const wasLiveStreaming = liveStreamActiveRef.current;
      liveStreamActiveRef.current = false;

      const languageHint = buildReplyLanguageHint(
        language,
        languageNameForPrompt(language, languageLabel(language))
      );

      if (wasLiveStreaming && isSocketOpen(replyWsRef.current)) {
        // Language hint → trailing silence → endTurn (order matters for ASR script).
        sendText(replyWsRef.current!, languageHint);
        await sendTrailingSilence(replyWsRef.current!);
        endTurn(replyWsRef.current!);
      } else {
        replyStructuredRef.current = null;
        replySegmentsRef.current = [];
        replyAbortRef.current = false;
        replyTurnEndedRef.current = false;

        const ws = await ensureReplySessionForQuestion(questionIndex);
        if (!isSocketOpen(ws)) {
          throw new Error("Reply agent session is not connected");
        }

        startTurn(ws, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
        sendPcm(ws, silentPcmChunk());
        await sleep(30);
        await sendRecordedPcmStream(ws, pcm);
        sendText(ws, languageHint);
        await sendTrailingSilence(ws);
        endTurn(ws);
      }

      return waitForReplyQuiet();
    },
    [ensureReplySessionForQuestion, stopMic, waitForReplyQuiet]
  );

  useEffect(() => {
    return () => {
      void cancelPlay({ settle: false });
      stopMic();
      stopQuestionnaireReplySession();
      disconnectLive(audioWsRef.current);
      audioWsRef.current = null;
      audioSessionRef.current = null;

      playerNodeRef.current?.disconnect();
      playerNodeRef.current = null;
      const playerCtx = playerCtxRef.current;
      playerCtxRef.current = null;
      if (playerCtx && playerCtx.state !== "closed") {
        void playerCtx.close().catch(() => {
          // Already closed (React Strict Mode remount).
        });
      }
    };
  }, [cancelPlay, stopMic, stopQuestionnaireReplySession]);

  return {
    playQuestion,
    cancelPlay,
    startRecording,
    stopRecordingAndTranscribe,
    stopQuestionnaireReplySession,
    setAnswerRecordingPaused,
  };
}
