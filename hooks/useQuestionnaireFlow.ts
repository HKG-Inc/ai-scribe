"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  REPLY_WARM_DELAY_MS,
  buildPlayAgentPrompt,
  buildReplyLanguageHint,
  languageNameForPrompt,
  normalizePlayTranslation,
} from "@/lib/questionnaire/constants";
import {
  compressSilenceChunks,
  concatInt16,
  connectLiveSocket,
  createLiveSilenceGate,
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
  releaseLiveSession,
  resamplePcm16,
  isLiveSessionAbortError,
  sendPcm,
  sendRecordedPcmStream,
  sendText,
  sendTrailingSilence,
  replyEventPriority,
  silentPcmChunk,
  sleep,
  startTurn,
  TARGET_PCM_SAMPLE_RATE,
  type LiveSessionInfo,
  type ReplyStructured,
} from "@/lib/questionnaire/live-client";

export function useQuestionnaireFlow() {
  const [isPlayConnecting, setIsPlayConnecting] = useState(false);
  const playAbortRef = useRef<AbortController | null>(null);
  const playEpochRef = useRef(0);
  const playTurnActiveRef = useRef(false);
  /** Bumped when the active play WS is dropped so in-flight active mints abort. */
  const audioConnectGenRef = useRef(0);
  const audioWsRef = useRef<WebSocket | null>(null);
  const audioSessionRef = useRef<LiveSessionInfo | null>(null);
  /** Pre-connected spare play session — promoted on Skip to avoid mint latency. */
  const standbyWsRef = useRef<WebSocket | null>(null);
  const standbySessionRef = useRef<LiveSessionInfo | null>(null);
  const standbyWarmPromiseRef = useRef<Promise<void> | null>(null);
  const replyWsRef = useRef<WebSocket | null>(null);
  const replySessionRef = useRef<LiveSessionInfo | null>(null);
  /** Question index this reply WS belongs to; reused for no-speech / replay. */
  const replyQuestionIndexRef = useRef<number | null>(null);
  const replyConnectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  /** True while we intentionally close reply WS (question change / unmount). */
  const replyExpectCloseRef = useRef(false);
  /** Live audio turn open until endTurn (or abort) — drives silent reconnect. */
  const replyNeedsLiveRef = useRef(false);
  /** Mic capture currently running (false once Stop begins). */
  const replyMicActiveRef = useRef(false);
  /** Monotonic id per reply live socket; newer session output replaces older. */
  const replyLiveGenerationRef = useRef(0);
  /** Generation whose tool/text output currently owns replyStructuredRef. */
  const replyAcceptedGenerationRef = useRef(0);
  const replyReconnectPromiseRef = useRef<Promise<WebSocket> | null>(null);
  /** True while replaying buffered PCM onto a freshly minted reply live. */
  const replyCatchingUpRef = useRef(false);
  /** Debounced reply pre-mint after the user stays on a question. */
  const replyWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Question index we already scheduled/completed a reply warm for (one mint max). */
  const replyWarmForQuestionRef = useRef<number | null>(null);
  const playerCtxRef = useRef<AudioContext | null>(null);
  const playerNodeRef = useRef<AudioWorkletNode | null>(null);
  /** HTMLAudioElement used when playing pre-stored WAV from platform storage. */
  const storageAudioRef = useRef<HTMLAudioElement | null>(null);
  const recCtxRef = useRef<AudioContext | null>(null);
  const recNodeRef = useRef<AudioWorkletNode | null>(null);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recSampleRateRef = useRef(TARGET_PCM_SAMPLE_RATE);
  const pcmPartsRef = useRef<Int16Array[]>([]);
  const liveSilenceGateRef = useRef(createLiveSilenceGate());
  const replySegmentsRef = useRef<ReplyStructured[]>([]);
  const replyStructuredRef = useRef<ReplyStructured | null>(null);
  /** Highest accepted reply source priority (set_model_response > emit_transcription > text). */
  const replyPriorityRef = useRef(0);
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

  const discardStandby = useCallback(() => {
    disconnectLive(standbyWsRef.current);
    standbyWsRef.current = null;
    standbySessionRef.current = null;
    standbyWarmPromiseRef.current = null;
  }, []);

  /**
   * 1008 / "operation was aborted" arrives as a JSON error while the socket can
   * still be OPEN. Drop the ref immediately so later sends never reuse it.
   */
  const retirePlaySocket = useCallback((ws: WebSocket) => {
    if (audioWsRef.current === ws) {
      audioWsRef.current = null;
      audioSessionRef.current = null;
    }
    if (standbyWsRef.current === ws) {
      standbyWsRef.current = null;
      standbySessionRef.current = null;
    }
    disconnectLive(ws);
  }, []);

  const attachPlaySocketGuards = useCallback(
    (ws: WebSocket) => {
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!isLiveSessionAbortError(parsed)) return;
        ws.removeEventListener("message", onMessage);
        retirePlaySocket(ws);
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", () => {
        ws.removeEventListener("message", onMessage);
        if (audioWsRef.current === ws) {
          audioWsRef.current = null;
          audioSessionRef.current = null;
        }
        if (standbyWsRef.current === ws) {
          standbyWsRef.current = null;
          standbySessionRef.current = null;
        }
      });
    },
    [retirePlaySocket]
  );

  /**
   * Promote a pre-warmed spare play WS if one exists (optional fast path).
   * Standby is no longer auto-minted after every question (stream cap).
   */
  const promoteStandby = useCallback((): WebSocket | null => {
    if (!isSocketOpen(standbyWsRef.current) || !standbySessionRef.current) {
      return null;
    }
    const ws = standbyWsRef.current;
    audioWsRef.current = ws;
    audioSessionRef.current = standbySessionRef.current;
    standbyWsRef.current = null;
    standbySessionRef.current = null;
    return ws;
  }, []);

  const stopStorageAudio = useCallback(() => {
    const audio = storageAudioRef.current;
    storageAudioRef.current = null;
    if (!audio) return;
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // ignore
    }
  }, []);

  /**
   * Stop local playback (storage WAV and/or agent PCM).
   * - settle:false (Skip): instant silence + drop active play WS; invalidate
   *   in-flight standby mints so Skip spam cannot stack live streams.
   * - settle:true: stop in-flight play; reuse open socket when still valid.
   */
  const cancelPlay = useCallback(async (options?: { settle?: boolean }) => {
    const wasActive = playTurnActiveRef.current || !!playAbortRef.current;
    const settle = options?.settle !== false;

    stopStorageAudio();
    if (playerNodeRef.current) {
      playerNodeRef.current.port.postMessage({ command: "reset" });
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    playEpochRef.current += 1;
    playAbortRef.current?.abort();
    playAbortRef.current = null;

    if (!settle) {
      // Invalidate in-flight play/standby mints; keep one open standby if present.
      audioConnectGenRef.current += 1;
      standbyWarmPromiseRef.current = null;
      if (replyWarmTimerRef.current) {
        clearTimeout(replyWarmTimerRef.current);
        replyWarmTimerRef.current = null;
      }
      if (wasActive || isSocketOpen(audioWsRef.current)) {
        disconnectLive(audioWsRef.current);
        audioWsRef.current = null;
        audioSessionRef.current = null;
      }
      playTurnActiveRef.current = false;
      return;
    }

    if (wasActive && isSocketOpen(audioWsRef.current)) {
      try {
        endTurn(audioWsRef.current);
      } catch {
        // ignore
      }
      // Brief wait so a late end is less likely to hit the next listener.
      await new Promise<void>((resolve) => {
        const ws = audioWsRef.current;
        if (!ws) {
          resolve();
          return;
        }
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          playTurnActiveRef.current = false;
          resolve();
        };
        const onMsg = (event: MessageEvent) => {
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
            // ignore
          }
        };
        ws.addEventListener("message", onMsg);
        const timer = setTimeout(finish, 300);
      });
      return;
    }

    playTurnActiveRef.current = false;
  }, [stopStorageAudio]);

  const ensureAudioLive = useCallback(
    async (agentSlug: string) => {
      if (isSocketOpen(audioWsRef.current) && audioSessionRef.current) {
        return audioWsRef.current!;
      }

      setIsPlayConnecting(true);
      try {
        const promoted = promoteStandby();
        if (promoted) {
          return promoted;
        }

        const connectGeneration = audioConnectGenRef.current;
        disconnectLive(audioWsRef.current);
        audioWsRef.current = null;

        const session = await mintQuestionnaireLiveSession(agentSlug);
        if (connectGeneration !== audioConnectGenRef.current) {
          await releaseLiveSession(session);
          throw new DOMException("Aborted", "AbortError");
        }
        audioSessionRef.current = session;
        const ws = await connectLiveSocket(session);
        if (connectGeneration !== audioConnectGenRef.current) {
          disconnectLive(ws);
          throw new DOMException("Aborted", "AbortError");
        }
        audioWsRef.current = ws;
        attachPlaySocketGuards(ws);
        return ws;
      } finally {
        setIsPlayConnecting(false);
      }
    },
    [attachPlaySocketGuards, promoteStandby]
  );

  const rememberReplySegment = useCallback(
    (found: ReplyStructured, priority: number, generation: number) => {
      if (!hasUsableReply(found) || priority <= 0) return;
      if (generation < replyAcceptedGenerationRef.current) return;

      // Newer live session wins — replace any provisional output from the old one.
      if (generation > replyAcceptedGenerationRef.current) {
        replyAcceptedGenerationRef.current = generation;
        replyPriorityRef.current = 0;
        replySegmentsRef.current = [];
        replyStructuredRef.current = null;
        replyTurnEndedRef.current = false;
      }

      // Lower-priority sources (e.g. emit_transcription) lose once a better one arrives.
      if (priority < replyPriorityRef.current) return;

      if (priority > replyPriorityRef.current) {
        replyPriorityRef.current = priority;
        replySegmentsRef.current = [found];
        replyStructuredRef.current = found;
        return;
      }

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
    },
    []
  );

  const handleReplyEvent = useCallback(
    (parsed: Record<string, unknown>, generation: number) => {
      // Only hard turn markers — data frames often set finished:true per chunk and
      // must not end the wait early (especially before set_model_response arrives).
      if (
        generation >= replyAcceptedGenerationRef.current &&
        (parsed.type === "end" || parsed.type === "turn_complete")
      ) {
        replyTurnEndedRef.current = true;
      }

      const found = extractStructured(parsed);
      const priority = replyEventPriority(parsed);
      if (found && priority > 0) {
        rememberReplySegment(found, priority, generation);
      }
    },
    [rememberReplySegment]
  );

  const reconnectReplyLiveRef = useRef<
    ((questionIndex: number) => Promise<WebSocket>) | null
  >(null);

  const attachReplySocketHandlers = useCallback(
    (ws: WebSocket, generation: number) => {
      let retired = false;

      const retireAndMaybeReconnect = () => {
        if (retired) return;
        retired = true;
        ws.removeEventListener("message", onMessage);
        if (replyWsRef.current === ws) {
          replyWsRef.current = null;
          replySessionRef.current = null;
        }
        // Force-close so nothing keeps writing to the aborted session.
        disconnectLive(ws);

        // Intentional teardown (skip / next / unmount) — do not remint.
        if (replyExpectCloseRef.current) return;
        // Turn already finalized on this live — keep any provisional output.
        if (!replyNeedsLiveRef.current) return;

        const questionIndex = replyQuestionIndexRef.current;
        if (questionIndex == null) return;

        liveStreamActiveRef.current = false;
        void reconnectReplyLiveRef.current?.(questionIndex).catch(() => {
          // Silent — stopRecordingAndTranscribe will surface failures.
        });
      };

      const onMessage = (event: MessageEvent) => {
        void (async () => {
          let payload: string | ArrayBuffer = event.data;
          if (payload instanceof Blob) {
            payload = await payload.arrayBuffer();
          }
          const parsed = parseLiveEvent(payload);
          if (parsed.binary) return;

          // 1008 often arrives as JSON while readyState is still OPEN.
          if (isLiveSessionAbortError(parsed)) {
            retireAndMaybeReconnect();
            return;
          }

          handleReplyEvent(parsed as Record<string, unknown>, generation);
        })();
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", () => {
        retireAndMaybeReconnect();
      });
    },
    [handleReplyEvent]
  );

  const reconnectReplyLive = useCallback(
    async (questionIndex: number): Promise<WebSocket> => {
      if (
        replyQuestionIndexRef.current === questionIndex &&
        replyReconnectPromiseRef.current
      ) {
        return replyReconnectPromiseRef.current;
      }

      const promise = (async () => {
        liveStreamActiveRef.current = false;
        replyCatchingUpRef.current = true;

        if (!isSocketOpen(replyWsRef.current)) {
          replyWsRef.current = null;
          replySessionRef.current = null;
        }

        const generation = ++replyLiveGenerationRef.current;
        replyQuestionIndexRef.current = questionIndex;

        // Fresh mint — do not reuse the expired session_id.
        const session = await mintQuestionnaireLiveSession(
          QUESTIONNAIRE_REPLY_AGENT
        );
        if (
          replyExpectCloseRef.current ||
          replyQuestionIndexRef.current !== questionIndex
        ) {
          await releaseLiveSession(session);
          throw new Error("Reply reconnect aborted");
        }

        const ws = await connectLiveSocket(session);
        if (
          replyExpectCloseRef.current ||
          replyQuestionIndexRef.current !== questionIndex
        ) {
          disconnectLive(ws);
          throw new Error("Reply reconnect aborted");
        }

        replySessionRef.current = session;
        replyWsRef.current = ws;
        attachReplySocketHandlers(ws, generation);

        startTurn(ws, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
        sendPcm(ws, silentPcmChunk());

        // Pass every buffered chunk (incl. speech during the dead gap) to the new live.
        let sentThrough = 0;
        const flushBuffered = async () => {
          while (sentThrough < pcmPartsRef.current.length) {
            if (!isSocketOpen(ws)) {
              throw new Error("Reply live closed during reconnect replay");
            }
            const chunk = pcmPartsRef.current[sentThrough]!;
            sentThrough += 1;
            sendPcm(ws, chunk);
            if (sentThrough % 50 === 0) {
              await sleep(0);
            }
          }
        };

        await flushBuffered();
        await flushBuffered();

        // Resume live mic streaming only if the user is still recording.
        if (replyMicActiveRef.current && replyNeedsLiveRef.current) {
          liveStreamActiveRef.current = true;
          await flushBuffered();
          replyCatchingUpRef.current = false;
          await flushBuffered();
        } else {
          replyCatchingUpRef.current = false;
        }
        return ws;
      })();

      replyReconnectPromiseRef.current = promise;
      try {
        return await promise;
      } finally {
        if (replyReconnectPromiseRef.current === promise) {
          replyReconnectPromiseRef.current = null;
        }
        replyCatchingUpRef.current = false;
      }
    },
    [attachReplySocketHandlers]
  );

  reconnectReplyLiveRef.current = reconnectReplyLive;

  const cancelReplyWarm = useCallback(() => {
    if (replyWarmTimerRef.current) {
      clearTimeout(replyWarmTimerRef.current);
      replyWarmTimerRef.current = null;
    }
  }, []);

  /** Close reply-agent session (Next / Skip / complete / unmount). */
  const stopQuestionnaireReplySession = useCallback(() => {
    cancelReplyWarm();
    replyWarmForQuestionRef.current = null;
    replyExpectCloseRef.current = true;
    replyNeedsLiveRef.current = false;
    replyMicActiveRef.current = false;
    replyInputBlockedRef.current = false;
    recordingPausedRef.current = false;
    liveStreamActiveRef.current = false;
    replyCatchingUpRef.current = false;
    replyConnectPromiseRef.current = null;
    replyReconnectPromiseRef.current = null;
    // Invalidate in-flight mint/connect so Skip does not leave a live stream open.
    replyQuestionIndexRef.current = null;
    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;
    replySessionRef.current = null;
    replyExpectCloseRef.current = false;
  }, [cancelReplyWarm]);

  /**
   * Ensure a reply-agent live WS for this question.
   * - Same question (no-speech retry / replay): reuse open session.
   * - New question: mint a fresh session and connect (no session_id reuse).
   * Minted-but-aborted sessions are released to avoid stream_cap_exceeded.
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
        replyReconnectPromiseRef.current
      ) {
        return replyReconnectPromiseRef.current;
      }

      if (
        replyQuestionIndexRef.current === questionIndex &&
        replyConnectPromiseRef.current
      ) {
        return replyConnectPromiseRef.current;
      }

      // Different question (or missing) — close previous session.
      replyExpectCloseRef.current = true;
      replyNeedsLiveRef.current = false;
      disconnectLive(replyWsRef.current);
      replyWsRef.current = null;
      replySessionRef.current = null;
      replyExpectCloseRef.current = false;
      replyQuestionIndexRef.current = questionIndex;

      const connectPromise = (async () => {
        const generation = ++replyLiveGenerationRef.current;
        const session = await mintQuestionnaireLiveSession(
          QUESTIONNAIRE_REPLY_AGENT
        );
        if (replyQuestionIndexRef.current !== questionIndex) {
          await releaseLiveSession(session);
          throw new Error("Reply session aborted for newer question");
        }
        replySessionRef.current = session;
        const ws = await connectLiveSocket(session);
        if (replyQuestionIndexRef.current !== questionIndex) {
          disconnectLive(ws);
          throw new Error("Reply session aborted for newer question");
        }
        replyWsRef.current = ws;
        attachReplySocketHandlers(ws, generation);
        return ws;
      })();

      replyConnectPromiseRef.current = connectPromise;
      try {
        return await connectPromise;
      } catch (error) {
        // Don't leave a stale index that blocks a later Record mint, or looks "warmed".
        if (
          replyQuestionIndexRef.current === questionIndex &&
          !isSocketOpen(replyWsRef.current)
        ) {
          replyQuestionIndexRef.current = null;
          replySessionRef.current = null;
          if (replyWarmForQuestionRef.current === questionIndex) {
            replyWarmForQuestionRef.current = null;
          }
        }
        throw error;
      } finally {
        if (replyConnectPromiseRef.current === connectPromise) {
          replyConnectPromiseRef.current = null;
        }
      }
    },
    [attachReplySocketHandlers]
  );

  /**
   * Mint reply-agent live 2s after play starts for this question.
   * One warm per question index — rapid re-schedules do not mint again.
   */
  const scheduleReplyWarm = useCallback(
    (questionIndex: number) => {
      // Already scheduled, connecting, or live for this question — do not mint again.
      if (replyWarmForQuestionRef.current === questionIndex) {
        if (
          replyWarmTimerRef.current ||
          replyConnectPromiseRef.current ||
          (replyQuestionIndexRef.current === questionIndex &&
            isSocketOpen(replyWsRef.current))
        ) {
          return;
        }
      }

      cancelReplyWarm();
      replyWarmForQuestionRef.current = questionIndex;
      replyWarmTimerRef.current = setTimeout(() => {
        replyWarmTimerRef.current = null;
        if (
          replyQuestionIndexRef.current === questionIndex &&
          isSocketOpen(replyWsRef.current)
        ) {
          return;
        }
        if (
          replyQuestionIndexRef.current === questionIndex &&
          replyConnectPromiseRef.current
        ) {
          return;
        }
        void ensureReplySessionForQuestion(questionIndex).catch(() => {
          // Best effort — Record will mint on demand.
          if (
            replyWarmForQuestionRef.current === questionIndex &&
            !isSocketOpen(replyWsRef.current)
          ) {
            replyWarmForQuestionRef.current = null;
          }
        });
      }, REPLY_WARM_DELAY_MS);
    },
    [cancelReplyWarm, ensureReplySessionForQuestion]
  );

  const setReplyInputBlocked = useCallback((blocked: boolean) => {
    replyInputBlockedRef.current = blocked;
  }, []);

  /**
   * Primary play path: fetch pre-recorded WAV + translated JSON from platform
   * storage, then play via HTMLAudioElement.
   *
   * Next-question metadata prefetch is kicked from playQuestion (in parallel),
   * not after this audio finishes.
   */
  const storageMetaCacheRef = useRef(
    new Map<string, Promise<{ translatedText: string; audioUrl: string }>>()
  );

  const fetchStorageMeta = useCallback(
    async (
      questionId: string,
      language: string,
      signal?: AbortSignal
    ): Promise<{ translatedText: string; audioUrl: string }> => {
      const key = `${language}_${questionId}`;
      const existing = storageMetaCacheRef.current.get(key);
      if (existing) {
        return existing;
      }

      const promise = (async () => {
        const { apiFetch } = await import("@/lib/utils");
        const params = new URLSearchParams({
          locale: language,
          question: questionId,
        });
        const response = await apiFetch(
          `/api/questionnaire/storage/question?${params.toString()}`,
          { signal, cache: "no-store" }
        );
        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          throw new Error(
            `Storage question fetch failed (${response.status}): ${errorText || response.statusText}`
          );
        }
        const data = (await response.json()) as {
          translatedText?: string;
          audioUrl?: string;
        };
        const translatedText = (data.translatedText || "").trim();
        const audioUrl = (data.audioUrl || "").trim();
        if (!translatedText || !audioUrl) {
          throw new Error("Storage question response missing text or audio");
        }
        return { translatedText, audioUrl };
      })();

      storageMetaCacheRef.current.set(key, promise);
      try {
        return await promise;
      } catch (error) {
        storageMetaCacheRef.current.delete(key);
        throw error;
      }
    },
    []
  );

  const prefetchNextStorageMeta = useCallback(
    (questionIndex: number, language: string) => {
      const question = QUESTIONS[questionIndex];
      if (!question) return;
      void fetchStorageMeta(question.id, language).catch(() => {
        // Best effort — play will fetch on demand.
      });
    },
    [fetchStorageMeta]
  );

  const playViaStorage = useCallback(
    async (
      question: Question,
      language: string,
      signal: AbortSignal,
      onTranslatedText?: (text: string) => void
    ): Promise<string> => {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const { translatedText, audioUrl } = await fetchStorageMeta(
        question.id,
        language,
        signal
      );
      onTranslatedText?.(translatedText);

      stopStorageAudio();
      playTurnActiveRef.current = true;

      try {
        await new Promise<void>((resolve, reject) => {
          const audio = new Audio(audioUrl);
          audio.preload = "auto";
          storageAudioRef.current = audio;
          let settled = false;

          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            audio.removeEventListener("ended", onEnded);
            audio.removeEventListener("error", onError);
            fn();
          };

          const onEnded = () => finish(() => resolve());
          const onError = () =>
            finish(() => reject(new Error("Storage audio playback failed")));
          const onAbort = () =>
            finish(() => {
              try {
                audio.pause();
              } catch {
                // ignore
              }
              reject(new DOMException("Aborted", "AbortError"));
            });

          audio.addEventListener("ended", onEnded);
          audio.addEventListener("error", onError);
          signal.addEventListener("abort", onAbort, { once: true });

          void audio.play().catch((error) => {
            finish(() =>
              reject(
                error instanceof Error
                  ? error
                  : new Error("Storage audio play() failed")
              )
            );
          });
        });
      } finally {
        if (storageAudioRef.current) {
          storageAudioRef.current = null;
        }
        playTurnActiveRef.current = false;
      }

      return translatedText;
    },
    [fetchStorageMeta, stopStorageAudio]
  );

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

      const prompt = buildPlayAgentPrompt(
        languageNameForPrompt(language, languageLabel(language)),
        question.text_en
      );

      let translatedText = language === PARENT_LANGUAGE ? question.text_en : "";

      const runPlayTurn = async (): Promise<string> => {
        abortIfNeeded();
        playerNodeRef.current?.port.postMessage({ command: "reset" });

        // Drop a dead socket so ensureAudioLive mints fresh (idle expiry / mid-play close).
        if (!isSocketOpen(audioWsRef.current)) {
          audioWsRef.current = null;
          audioSessionRef.current = null;
        }

        const ws = await ensureAudioLive(QUESTIONNAIRE_PLAY_AGENT);
        abortIfNeeded();

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
            ws.removeEventListener("close", onClose);
            notifyPlaySettled();
            resolve();
          };

          const finishReject = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            ws.removeEventListener("message", onMessage);
            ws.removeEventListener("close", onClose);
            // Keep playTurnActive true so cancelPlay can drain the interrupted turn
            // when the socket is still open; soft-cancel clears it after disconnect.
            if (!signal.aborted) {
              notifyPlaySettled();
            }
            reject(error);
          };

          const isCurrent = () =>
            !signal.aborted && playEpochRef.current === myEpoch;

          const onClose = () => {
            if (!isCurrent() || settled) return;
            // Idle/mid-play expiry: only force a full replay when translation is missing.
            if (translatedText.trim()) {
              finishResolve();
              return;
            }
            finishReject(new Error("Play live closed before translation"));
          };

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

              if (isLiveSessionAbortError(parsed)) {
                // Drop aborted socket immediately — do not keep sending on it.
                if (audioWsRef.current === ws) {
                  audioWsRef.current = null;
                  audioSessionRef.current = null;
                }
                disconnectLive(ws);
                if (translatedText.trim()) {
                  finishResolve();
                } else {
                  finishReject(new Error("Play live aborted before translation"));
                }
                return;
              }

              if (parsed.binary && playerNodeRef.current) {
                heardOutput = true;
                playerNodeRef.current.port.postMessage(parsed.binary, [
                  parsed.binary,
                ]);
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
                  (source === "output" ||
                    source === "output_transcription" ||
                    !source)
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
          ws.addEventListener("close", onClose);
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
      };

      try {
        return await runPlayTurn();
      } catch (error) {
        if (signal.aborted) throw error;
        // Already have translation (or English seed text) — do not re-speak.
        if (translatedText.trim()) {
          return translatedText;
        }
        // Mid-question drop with no translation: remint and play once more.
        audioConnectGenRef.current += 1;
        disconnectLive(audioWsRef.current);
        audioWsRef.current = null;
        audioSessionRef.current = null;
        return await runPlayTurn();
      }
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

      // Do not mint reply immediately — schedule 2s after play starts.
      cancelReplyWarm();

      // Settle any in-flight play so a late end cannot stop this question.
      const epochBeforeSettle = playEpochRef.current;
      await cancelPlay({ settle: true });
      // Another skip/cancel raced us during settle — do not start stale audio.
      if (playEpochRef.current !== epochBeforeSettle + 1) {
        throw new DOMException("Aborted", "AbortError");
      }
      setReplyInputBlocked(true);

      const controller = new AbortController();
      playAbortRef.current = controller;
      playEpochRef.current += 1;
      const playEpoch = playEpochRef.current;

      // qN reply-agent: mint 2s after this play starts (do not wait for audio end).
      scheduleReplyWarm(questionIndex);
      // qN+1 audio/text URL: fetch in parallel now — do not wait for qN to finish.
      prefetchNextStorageMeta(questionIndex + 1, language);

      let translatedText = "";
      const notifyTranslation = (text: string) => {
        if (!text.trim()) return;
        translatedText = text;
        options?.onTranslatedText?.(text);
      };

      try {
        // Primary: platform storage (pre-recorded wav + json translation).
        // Fallback: live questionnaire-agent TTS/translate when storage fails.
        try {
          translatedText = await playViaStorage(
            question,
            language,
            controller.signal,
            notifyTranslation
          );
        } catch (storageError) {
          if (controller.signal.aborted || playEpochRef.current !== playEpoch) {
            throw storageError;
          }
          console.warn(
            "[questionnaire] storage play failed; falling back to agent",
            storageError instanceof Error ? storageError.message : storageError
          );
          translatedText = await playViaAgent(
            question,
            language,
            controller.signal,
            notifyTranslation
          );
        }
      } finally {
        if (playAbortRef.current === controller) {
          playAbortRef.current = null;
        }
        setReplyInputBlocked(false);
      }

      return { translatedText };
    },
    [
      cancelPlay,
      cancelReplyWarm,
      playViaAgent,
      playViaStorage,
      prefetchNextStorageMeta,
      scheduleReplyWarm,
      setReplyInputBlocked,
    ]
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
   * Prefers a reply session pre-warmed after play settle; otherwise mints now.
   */
  const startRecording = useCallback(
    async (questionIndex: number) => {
      cancelReplyWarm();
      await cancelPlay({ settle: true });
      setReplyInputBlocked(false);
      recordingPausedRef.current = false;
      pcmPartsRef.current = [];
      liveSilenceGateRef.current.reset();
      liveStreamActiveRef.current = false;
      replyMicActiveRef.current = false;
      replyNeedsLiveRef.current = false;
      replyCatchingUpRef.current = false;

      replyStructuredRef.current = null;
      replySegmentsRef.current = [];
      replyPriorityRef.current = 0;
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
        replyAcceptedGenerationRef.current = replyLiveGenerationRef.current;
        if (isSocketOpen(replyWs)) {
          startTurn(replyWs, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
          sendPcm(replyWs, silentPcmChunk());
          replyNeedsLiveRef.current = true;
          replyMicActiveRef.current = true;
          liveStreamActiveRef.current = true;
        }
      } catch {
        liveStreamActiveRef.current = false;
        replyNeedsLiveRef.current = false;
        replyMicActiveRef.current = true;
      }

      recNodeRef.current.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer) || recordingPausedRef.current) return;
        const raw = new Int16Array(event.data.slice(0));
        const chunk =
          recSampleRateRef.current !== TARGET_PCM_SAMPLE_RATE
            ? resamplePcm16(raw, recSampleRateRef.current, TARGET_PCM_SAMPLE_RATE)
            : raw;
        pcmPartsRef.current.push(chunk as Int16Array);

        if (
          liveStreamActiveRef.current &&
          !replyCatchingUpRef.current &&
          isSocketOpen(replyWsRef.current)
        ) {
          try {
            // Drop long mid-utterance pauses; trailing silence is sent on Stop.
            if (
              liveSilenceGateRef.current.shouldSend(
                chunk as Int16Array,
                pcmPartsRef.current
              )
            ) {
              sendPcm(replyWsRef.current!, chunk as Int16Array);
            }
          } catch {
            liveStreamActiveRef.current = false;
          }
        }
      };
      if (recCtxRef.current.state === "suspended") {
        await recCtxRef.current.resume();
      }
    },
    [
      cancelPlay,
      cancelReplyWarm,
      ensureReplySessionForQuestion,
      setReplyInputBlocked,
    ]
  );

  const setAnswerRecordingPaused = useCallback((paused: boolean) => {
    recordingPausedRef.current = paused;
  }, []);

  const waitForReplyQuiet = useCallback(async (): Promise<ReplyStructured | null> => {
    const started = Date.now();
    let lastCount = replySegmentsRef.current.length;
    let lastChange = Date.now();
    let turnEndedAt: number | null = null;
    let lastPriority = replyPriorityRef.current;

    while (Date.now() - started < REPLY_MAX_WAIT_MS) {
      if (replyAbortRef.current) break;

      if (replyTurnEndedRef.current && turnEndedAt === null) {
        turnEndedAt = Date.now();
      }

      if (replySegmentsRef.current.length !== lastCount) {
        lastCount = replySegmentsRef.current.length;
        lastChange = Date.now();
      }
      if (replyPriorityRef.current !== lastPriority) {
        lastPriority = replyPriorityRef.current;
        lastChange = Date.now();
      }

      const usable = hasUsableReply(replyStructuredRef.current);
      // Prefer set_model_response (priority 3); don't settle early on text-only.
      const hasPreferred = replyPriorityRef.current >= 3;
      const quietFor = Date.now() - lastChange;

      if (usable && hasPreferred && quietFor >= REPLY_QUIET_MS) {
        break;
      }

      if (usable && hasPreferred && turnEndedAt !== null && Date.now() - turnEndedAt >= 400) {
        break;
      }

      // After turn end, wait ~2s for set_model_response before accepting lower-priority text.
      if (
        usable &&
        turnEndedAt !== null &&
        Date.now() - turnEndedAt >= 2000 &&
        quietFor >= REPLY_QUIET_MS
      ) {
        break;
      }

      // Agent omitted turn_complete — settle on a stable reply after a longer quiet.
      if (usable && turnEndedAt === null && quietFor >= REPLY_QUIET_MS * 2) {
        break;
      }

      // No usable reply yet: keep waiting until REPLY_MAX_WAIT_MS (do not bail at 2.5s).

      await sleep(80);
    }

    return replyStructuredRef.current;
  }, []);

  /**
   * Stop local recording, end the live audio turn (or fallback-send full
   * buffer), and wait for transcription. Keeps the reply session open so a
   * no-speech retry can reuse it.
   *
   * Mid-utterance pauses are trimmed; language hint + trailing silence are
   * sent before endTurn so ASR keeps native script and can finalize.
   *
   * If the live died mid-answer, wait for silent reconnect (full PCM replay)
   * then finalize on the new session — provisional session-1 output is kept
   * until session-2 tool/text output replaces it.
   */
  const stopRecordingAndTranscribe = useCallback(
    async (
      questionIndex: number,
      language: string
    ): Promise<ReplyStructured | null> => {
      recordingPausedRef.current = false;
      replyMicActiveRef.current = false;
      liveStreamActiveRef.current = false;
      stopMic();

      // Compress mid-speech pauses; intentional quiet is appended via sendTrailingSilence.
      const { parts: speechParts } = compressSilenceChunks(pcmPartsRef.current);
      const pcm = concatInt16(speechParts);

      if (pcm.length < MIN_ANSWER_SAMPLES) {
        replyNeedsLiveRef.current = false;
        throw new Error("Recording too short. Speak longer, then stop.");
      }

      if (pcmRms(pcm) < 180) {
        replyNeedsLiveRef.current = false;
        throw new Error("Could not detect speech in the recording. Speak louder and try again.");
      }

      const languageHint = buildReplyLanguageHint(
        language,
        languageNameForPrompt(language, languageLabel(language))
      );

      const finalizeOnLive = async (ws: WebSocket) => {
        sendText(ws, languageHint);
        await sendTrailingSilence(ws);
        endTurn(ws);
        replyNeedsLiveRef.current = false;
      };

      // Wait for in-flight silent reconnect; if the socket is already dead, remint.
      try {
        if (replyReconnectPromiseRef.current) {
          await replyReconnectPromiseRef.current;
        } else if (!isSocketOpen(replyWsRef.current) && replyNeedsLiveRef.current) {
          await reconnectReplyLive(questionIndex);
        }
      } catch {
        // Fall through to full-buffer path below.
      }

      if (isSocketOpen(replyWsRef.current)) {
        // Live path (original or reconnected): audio already on the wire.
        await finalizeOnLive(replyWsRef.current!);
      } else {
        // Keep provisional session-1 output until this live's tool/text replaces it.
        replyAbortRef.current = false;

        const ws = await ensureReplySessionForQuestion(questionIndex);
        if (!isSocketOpen(ws)) {
          replyNeedsLiveRef.current = false;
          throw new Error("Reply agent session is not connected");
        }

        replyNeedsLiveRef.current = true;
        startTurn(ws, "audio", `audio/pcm;rate=${TARGET_PCM_SAMPLE_RATE}`);
        sendPcm(ws, silentPcmChunk());
        await sleep(30);
        await sendRecordedPcmStream(ws, pcm);
        await finalizeOnLive(ws);
      }

      return waitForReplyQuiet();
    },
    [ensureReplySessionForQuestion, reconnectReplyLive, stopMic, waitForReplyQuiet]
  );

  useEffect(() => {
    return () => {
      void cancelPlay({ settle: false });
      stopStorageAudio();
      stopMic();
      stopQuestionnaireReplySession();
      disconnectLive(audioWsRef.current);
      audioWsRef.current = null;
      audioSessionRef.current = null;
      discardStandby();

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
  }, [cancelPlay, discardStandby, stopMic, stopQuestionnaireReplySession, stopStorageAudio]);

  return {
    playQuestion,
    cancelPlay,
    startRecording,
    stopRecordingAndTranscribe,
    stopQuestionnaireReplySession,
    setAnswerRecordingPaused,
    /** True while play-agent live mint/connect is in flight. */
    isPlayConnecting,
  };
}
