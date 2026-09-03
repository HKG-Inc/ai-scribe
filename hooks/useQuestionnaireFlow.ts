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
  languageNameForPrompt,
} from "@/lib/questionnaire/constants";
import {
  compressSilenceChunks,
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
  const audioWsRef = useRef<WebSocket | null>(null);
  const audioSessionRef = useRef<LiveSessionInfo | null>(null);
  const replyWsRef = useRef<WebSocket | null>(null);
  const replySessionRef = useRef<LiveSessionInfo | null>(null);
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

  const ensurePlayer = useCallback(async () => {
    if (playerNodeRef.current) return;
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
   * Stop local playback. When a play turn is active, interrupt the agent and
   * drain until turn_complete/end (or timeout) so a late end cannot land on the
   * next question's listener and stop its audio.
   */
  const cancelPlay = useCallback(async (options?: { settle?: boolean }) => {
    playEpochRef.current += 1;
    const wasActive = playTurnActiveRef.current || !!playAbortRef.current;
    playAbortRef.current?.abort();
    playAbortRef.current = null;

    if (playerNodeRef.current) {
      playerNodeRef.current.port.postMessage({ command: "reset" });
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    const ws = audioWsRef.current;
    const shouldSettle = options?.settle !== false && wasActive && isSocketOpen(ws);

    if (!shouldSettle) {
      playTurnActiveRef.current = false;
      return;
    }

    try {
      endTurn(ws!);
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ws!.removeEventListener("message", onDrainMessage);
        playTurnActiveRef.current = false;
        resolve();
      };

      const onDrainMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
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

      ws!.addEventListener("message", onDrainMessage);
      const timer = setTimeout(finish, 400);
    });
  }, []);

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

  const connectReplyLive = useCallback(async () => {
    if (isSocketOpen(replyWsRef.current) && replySessionRef.current) {
      return replyWsRef.current!;
    }

    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;

    const existingSessionId = replySessionRef.current?.session_id;
    const session = await mintQuestionnaireLiveSession(
      QUESTIONNAIRE_REPLY_AGENT,
      existingSessionId
    );
    replySessionRef.current = session;
    const ws = await connectLiveSocket(session);
    replyWsRef.current = ws;
    attachReplySocketHandlers(ws);
    return ws;
  }, [attachReplySocketHandlers]);

  /** Close reply-agent session when questionnaire ends. */
  const stopQuestionnaireReplySession = useCallback(() => {
    replyInputBlockedRef.current = false;
    recordingPausedRef.current = false;
    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;
    replySessionRef.current = null;
  }, []);

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
      await ensurePlayer();
      playerNodeRef.current?.port.postMessage({ command: "reset" });

      const prompt = buildPlayAgentPrompt(
        languageNameForPrompt(language, languageLabel(language)),
        question.text_en
      );

      const ws = await ensureAudioLive(QUESTIONNAIRE_PLAY_AGENT);
      let translatedText = language === PARENT_LANGUAGE ? question.text_en : "";
      const myEpoch = playEpochRef.current;
      let heardOutput = false;

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
          // Keep playTurnActive true so cancelPlay can drain the interrupted turn.
          if (!signal.aborted) {
            notifyPlaySettled();
          }
          reject(error);
        };

        const isCurrent = () =>
          !signal.aborted && playEpochRef.current === myEpoch;

        const onMessage = (event: MessageEvent) => {
          if (!isCurrent()) {
            return;
          }

          void (async () => {
            let payload: string | ArrayBuffer = event.data;
            if (payload instanceof Blob) {
              payload = await payload.arrayBuffer();
            }
            if (!isCurrent()) return;

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
              const text = parsed.content.trim();
              const source = parsed.source || "";
              if (
                text &&
                source !== "input_transcription" &&
                (source === "output" || source === "output_transcription" || !source)
              ) {
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

        ws.addEventListener("message", onMessage);
        startTurn(ws, "text");
        sendText(ws, prompt);
        endTurn(ws);

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
      await cancelPlay({ settle: true });
      setReplyInputBlocked(true);

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
    [cancelPlay, playViaAgent, setReplyInputBlocked]
  );

  const stopMic = useCallback(() => {
    recNodeRef.current?.disconnect();
    recNodeRef.current = null;
    recStreamRef.current?.getTracks().forEach((track) => track.stop());
    recStreamRef.current = null;
    if (recCtxRef.current) {
      void recCtxRef.current.close();
      recCtxRef.current = null;
    }
  }, []);

  /** Record locally only; reply-agent is called after the patient stops. */
  const startRecording = useCallback(async () => {
    await cancelPlay({ settle: true });
    setReplyInputBlocked(false);
    recordingPausedRef.current = false;
    pcmPartsRef.current = [];

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
    recNodeRef.current.port.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer) || recordingPausedRef.current) return;
      const raw = new Int16Array(event.data.slice(0));
      const chunk =
        recSampleRateRef.current !== TARGET_PCM_SAMPLE_RATE
          ? resamplePcm16(raw, recSampleRateRef.current, TARGET_PCM_SAMPLE_RATE)
          : raw;
      pcmPartsRef.current.push(chunk as Int16Array);
    };
    if (recCtxRef.current.state === "suspended") {
      await recCtxRef.current.resume();
    }
  }, [cancelPlay, setReplyInputBlocked]);

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
   * Stop local recording, then call questionnaire-reply-agent with the full audio
   * and wait until the agent returns a transcription.
   */
  const stopRecordingAndTranscribe = useCallback(async (): Promise<ReplyStructured | null> => {
    recordingPausedRef.current = false;
    stopMic();

    const compressed = compressSilenceChunks(pcmPartsRef.current);
    pcmPartsRef.current = compressed.parts;
    const pcm = concatInt16(pcmPartsRef.current);

    if (pcm.length < MIN_ANSWER_SAMPLES) {
      throw new Error("Recording too short. Speak longer, then stop.");
    }

    if (pcmRms(pcm) < 180) {
      throw new Error("Could not detect speech in the recording. Speak louder and try again.");
    }

    replyStructuredRef.current = null;
    replySegmentsRef.current = [];
    replyAbortRef.current = false;
    replyTurnEndedRef.current = false;

    const ws = await connectReplyLive();
    if (!isSocketOpen(ws)) {
      throw new Error("Reply agent session is not connected");
    }

    startTurn(ws, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
    sendPcm(ws, silentPcmChunk());
    await sleep(30);
    await sendRecordedPcmStream(ws, pcm);
    endTurn(ws);

    return waitForReplyQuiet();
  }, [connectReplyLive, stopMic, waitForReplyQuiet]);

  useEffect(() => {
    return () => {
      void cancelPlay({ settle: false });
      stopMic();
      stopQuestionnaireReplySession();
      disconnectLive(audioWsRef.current);
      if (playerCtxRef.current) {
        void playerCtxRef.current.close();
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
