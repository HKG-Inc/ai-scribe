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
  /** Live PCM is streamed only while the patient is recording an answer. */
  const replySendingEnabledRef = useRef(false);
  /** Block mic → reply-agent while a question is playing (avoid question audio as input). */
  const replyInputBlockedRef = useRef(false);
  const answerTurnActiveRef = useRef(false);
  const livePcmSamplesSentRef = useRef(0);
  const pauseKeepaliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const replySessionOpenedRef = useRef(false);

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

  const cancelPlay = useCallback(() => {
    playAbortRef.current?.abort();
    playAbortRef.current = null;
    if (playerNodeRef.current) {
      playerNodeRef.current.port.postMessage({ command: "reset" });
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
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
      ws.onmessage = (event) => {
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

      ws.addEventListener("close", () => {
        if (replyWsRef.current === ws) {
          replyWsRef.current = null;
          answerTurnActiveRef.current = false;
          replySendingEnabledRef.current = false;
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

  /**
   * Open one reply-agent WebSocket after the first question is spoken.
   * Kept alive until the questionnaire ends; each answer uses start/end turns only.
   */
  const startQuestionnaireReplySession = useCallback(async () => {
    if (replySessionOpenedRef.current && isSocketOpen(replyWsRef.current)) {
      return replyWsRef.current!;
    }
    replySessionOpenedRef.current = true;
    return connectReplyLive();
  }, [connectReplyLive]);

  const stopPauseKeepalive = useCallback(() => {
    if (pauseKeepaliveTimerRef.current) {
      clearInterval(pauseKeepaliveTimerRef.current);
      pauseKeepaliveTimerRef.current = null;
    }
  }, []);

  const startPauseKeepalive = useCallback(() => {
    stopPauseKeepalive();
    pauseKeepaliveTimerRef.current = setInterval(() => {
      if (
        !answerTurnActiveRef.current ||
        replySendingEnabledRef.current ||
        replyInputBlockedRef.current
      ) {
        return;
      }
      const ws = replyWsRef.current;
      if (!isSocketOpen(ws)) return;
      sendPcm(ws!, silentPcmChunk());
    }, 4000);
  }, [stopPauseKeepalive]);

  /** Close reply-agent session when questionnaire ends. */
  const stopQuestionnaireReplySession = useCallback(() => {
    replySendingEnabledRef.current = false;
    replyInputBlockedRef.current = false;
    answerTurnActiveRef.current = false;
    livePcmSamplesSentRef.current = 0;
    replySessionOpenedRef.current = false;
    stopPauseKeepalive();
    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;
    replySessionRef.current = null;
  }, [stopPauseKeepalive]);

  const setReplyInputBlocked = useCallback((blocked: boolean) => {
    replyInputBlockedRef.current = blocked;
  }, []);

  const sendLivePcmChunk = useCallback((chunk: Int16Array) => {
    if (
      !replySendingEnabledRef.current ||
      replyInputBlockedRef.current ||
      !answerTurnActiveRef.current
    ) {
      return;
    }

    const ws = replyWsRef.current;
    if (!isSocketOpen(ws)) return;

    sendPcm(ws!, chunk);
    livePcmSamplesSentRef.current += chunk.length;
  }, []);

  const beginAnswerTurn = useCallback(async () => {
    replyStructuredRef.current = null;
    replySegmentsRef.current = [];
    replyAbortRef.current = false;
    replyTurnEndedRef.current = false;
    livePcmSamplesSentRef.current = 0;

    if (!replySessionOpenedRef.current) {
      throw new Error("Reply session is not ready yet. Wait for the question to finish playing.");
    }

    let ws = replyWsRef.current;
    if (!isSocketOpen(ws)) {
      ws = await connectReplyLive();
    }

    startTurn(ws, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
    sendPcm(ws, silentPcmChunk());
    answerTurnActiveRef.current = true;
    replySendingEnabledRef.current = true;
  }, [connectReplyLive]);

  const setAnswerRecordingPaused = useCallback(
    (paused: boolean) => {
      replySendingEnabledRef.current = !paused && answerTurnActiveRef.current;
      if (paused && answerTurnActiveRef.current) {
        startPauseKeepalive();
      } else {
        stopPauseKeepalive();
      }
    },
    [startPauseKeepalive, stopPauseKeepalive]
  );

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

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(), 25000);

        const onMessage = (event: MessageEvent) => {
          if (signal.aborted) {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }

          void (async () => {
            let payload: string | ArrayBuffer = event.data;
            if (payload instanceof Blob) {
              payload = await payload.arrayBuffer();
            }

            const parsed = parseLiveEvent(payload);
            if (parsed.binary && playerNodeRef.current) {
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
                translatedText = text;
                onTranslatedText?.(text);
              }
            }

            if (
              parsed.type === "turn_complete" ||
              parsed.type === "end" ||
              parsed.finished === true
            ) {
              clearTimeout(timeout);
              ws.removeEventListener("message", onMessage);
              resolve();
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
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });

      return translatedText;
    },
    [ensureAudioLive, ensurePlayer]
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

      cancelPlay();
      setReplyInputBlocked(true);

      const controller = new AbortController();
      playAbortRef.current = controller;

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
        playAbortRef.current = null;
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

  const startRecording = useCallback(async () => {
    cancelPlay();
    setReplyInputBlocked(false);
    stopPauseKeepalive();
    pcmPartsRef.current = [];
    replySendingEnabledRef.current = false;
    answerTurnActiveRef.current = false;

    // One persistent WS; each answer opens a new audio turn on it.
    await beginAnswerTurn();

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
      if (!(event.data instanceof ArrayBuffer)) return;
      let chunk = new Int16Array(event.data.slice(0));
      if (recSampleRateRef.current !== TARGET_PCM_SAMPLE_RATE) {
        chunk = resamplePcm16(
          chunk,
          recSampleRateRef.current,
          TARGET_PCM_SAMPLE_RATE
        );
      }
      pcmPartsRef.current.push(chunk);
      sendLivePcmChunk(chunk);
    };
    if (recCtxRef.current.state === "suspended") {
      await recCtxRef.current.resume();
    }
  }, [
    beginAnswerTurn,
    cancelPlay,
    sendLivePcmChunk,
    setReplyInputBlocked,
    stopPauseKeepalive,
  ]);

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

  const stopRecordingAndTranscribe = useCallback(async (): Promise<ReplyStructured | null> => {
    replySendingEnabledRef.current = false;
    stopPauseKeepalive();
    stopMic();

    const compressed = compressSilenceChunks(pcmPartsRef.current);
    pcmPartsRef.current = compressed.parts;
    const pcm = concatInt16(pcmPartsRef.current);

    if (pcm.length < MIN_ANSWER_SAMPLES) {
      answerTurnActiveRef.current = false;
      throw new Error("Recording too short. Speak longer, then stop.");
    }

    const ws = replyWsRef.current;
    if (!isSocketOpen(ws) || !answerTurnActiveRef.current) {
      answerTurnActiveRef.current = false;
      throw new Error("Reply agent session is not connected");
    }

    // Stream live while recording; on stop always replay the full buffered PCM, then end turn.
    await sendRecordedPcmStream(ws!, pcm);
    endTurn(ws!);
    answerTurnActiveRef.current = false;
    livePcmSamplesSentRef.current = 0;
    return waitForReplyQuiet();
  }, [stopMic, stopPauseKeepalive, waitForReplyQuiet]);

  useEffect(() => {
    return () => {
      cancelPlay();
      stopMic();
      stopPauseKeepalive();
      stopQuestionnaireReplySession();
      disconnectLive(audioWsRef.current);
      if (playerCtxRef.current) {
        void playerCtxRef.current.close();
      }
    };
  }, [cancelPlay, stopMic, stopPauseKeepalive, stopQuestionnaireReplySession]);

  return {
    playQuestion,
    cancelPlay,
    startRecording,
    stopRecordingAndTranscribe,
    startQuestionnaireReplySession,
    stopQuestionnaireReplySession,
    setAnswerRecordingPaused,
  };
}
