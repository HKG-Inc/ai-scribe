"use client";

import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/utils";
import { getPcmRecorderWorkletUrl } from "@/lib/questionnaire/live-client";

const INPUT_AUDIO_RATE = 16000;
const KEEPALIVE_MS = 4000;
const SILENT_PCM_MS = 40;
const RECONNECT_BASE_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 15000;
const SPEECH_THRESHOLD = 0.01;
const PROTOCOL_VERSION = 2;

interface LiveSessionResponse {
  session_id: string;
  wss_url: string;
  live_token: string;
  protocol_version?: number;
  error?: string;
}

export interface LiveTranscriptionCallbacks {
  onLiveDraft: (text: string) => void;
  onTurnComplete: (text: string) => void;
  onConnectionState: (state: { isConnected: boolean; isConnecting: boolean }) => void;
  onSpeechDetected: (detected: boolean) => void;
  onError: (id: string) => void;
  onClearError?: (idPrefix: string) => void;
  onSessionId?: (sessionId: string) => void;
}

function createSessionId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function silentPcmBytes(ms = SILENT_PCM_MS) {
  const byteCount = Math.round((INPUT_AUDIO_RATE * ms) / 1000) * 2;
  return new Uint8Array(byteCount);
}

function getWorkletUrl() {
  return getPcmRecorderWorkletUrl();
}

/** Same as live_transcriber.html */
function isTranscriptContinuation(prev: string, next: string) {
  const a = String(prev || "").trim().toLowerCase();
  const b = String(next || "").trim().toLowerCase();
  if (!a || !b) return true;
  return b.startsWith(a) || a.startsWith(b);
}

/** Same as live_transcriber.html */
function stripCommittedTranscriptPrefix(text: string, completedTranscript: string) {
  let rest = String(text || "").trim();
  if (!rest || !completedTranscript.trim()) return rest;

  for (const line of completedTranscript.split("\n")) {
    const seg = line.trim();
    if (!seg) continue;
    if (rest.toLowerCase().startsWith(seg.toLowerCase())) {
      rest = rest.slice(seg.length).replace(/^[\s.,;:|\-]+/, "");
    } else {
      break;
    }
  }

  const flatCommitted = completedTranscript.replace(/\n/g, " ").trim();
  if (flatCommitted && rest.toLowerCase().startsWith(flatCommitted.toLowerCase())) {
    rest = rest.slice(flatCommitted.length).replace(/^[\s.,;:|\-]+/, "");
  }

  return rest.trim();
}

export function useLiveTranscription(callbacks: LiveTranscriptionCallbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  /** Matches HTML `currentTurnText` — open turn live text */
  const currentTurnTextRef = useRef("");
  /** Matches HTML `completedTranscript` — committed turns joined by newlines */
  const completedTranscriptRef = useRef("");
  const transcriptTextSourceRef = useRef<string | null>(null);
  const wsInputThisTurnRef = useRef(false);
  const audioStartedRef = useRef(false);
  const audioSendingEnabledRef = useRef(false);
  const sessionActiveRef = useRef(false);
  const manualCloseRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepaliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderNodeRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speechRafRef = useRef<number | null>(null);

  const stopSpeechMonitor = useCallback(() => {
    if (speechRafRef.current !== null) {
      cancelAnimationFrame(speechRafRef.current);
      speechRafRef.current = null;
    }
    callbacksRef.current.onSpeechDetected(false);
  }, []);

  const startSpeechMonitor = useCallback(() => {
    stopSpeechMonitor();

    const tick = () => {
      const analyser = analyserRef.current;
      if (!analyser || !audioSendingEnabledRef.current) {
        callbacksRef.current.onSpeechDetected(false);
        speechRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);

      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const normalized = (buf[i] - 128) / 128;
        sumSq += normalized * normalized;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      callbacksRef.current.onSpeechDetected(rms >= SPEECH_THRESHOLD);
      speechRafRef.current = requestAnimationFrame(tick);
    };

    speechRafRef.current = requestAnimationFrame(tick);
  }, [stopSpeechMonitor]);

  const sendAudioPcm = useCallback((bytes: Uint8Array) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !audioStartedRef.current) {
      return;
    }
    socket.send(bytes);
  }, []);

  const stopKeepalive = useCallback(() => {
    if (keepaliveTimerRef.current) {
      clearInterval(keepaliveTimerRef.current);
      keepaliveTimerRef.current = null;
    }
  }, []);

  const startKeepalive = useCallback(() => {
    stopKeepalive();
    keepaliveTimerRef.current = setInterval(() => {
      sendAudioPcm(silentPcmBytes(SILENT_PCM_MS));
    }, KEEPALIVE_MS);
  }, [sendAudioPcm, stopKeepalive]);

  const stopReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Replace in place — input_transcription partials are cumulative
   * (same as live_transcriber.html `setTranscriptText`).
   */
  const setTranscriptText = useCallback((text: string, options?: { append?: boolean }) => {
    const prev = currentTurnTextRef.current || "";
    const next = String(text || "");
    const append = options?.append === true;
    const merged = append
      ? next.startsWith(prev) || prev.startsWith(next)
        ? next.length >= prev.length
          ? next
          : prev
        : prev + next
      : next;

    currentTurnTextRef.current = merged;
    callbacksRef.current.onLiveDraft(merged);
  }, []);

  /** Same as live_transcriber.html `finishCurrentTurn` */
  const finishCurrentTurn = useCallback(() => {
    const currentTurnText = currentTurnTextRef.current;
    currentTurnTextRef.current = "";
    callbacksRef.current.onLiveDraft("");

    if (currentTurnText) {
      completedTranscriptRef.current +=
        (completedTranscriptRef.current ? "\n" : "") + currentTurnText;
      callbacksRef.current.onTurnComplete(currentTurnText);
    }
  }, []);

  /** Same as live_transcriber.html `applyInputTranscription` */
  const applyInputTranscription = useCallback(
    (text: string, finished: boolean) => {
      const cleaned = stripCommittedTranscriptPrefix(text, completedTranscriptRef.current);
      if (!cleaned) return;

      // Gemini often omits finished=true between utterances. If the new text is not a
      // growing/revising partial of the open turn, commit the previous line first so
      // turn 2 is not replaced by turn 3.
      if (
        currentTurnTextRef.current &&
        !isTranscriptContinuation(currentTurnTextRef.current, cleaned)
      ) {
        finishCurrentTurn();
      }

      setTranscriptText(cleaned);
      if (finished) {
        finishCurrentTurn();
      }
    },
    [finishCurrentTurn, setTranscriptText]
  );

  /** Same as live_transcriber.html `handleWsJsonFrame` */
  const handleWsJsonFrame = useCallback(
    (frame: {
      type?: string;
      modality?: string;
      source?: string;
      content?: string;
      message?: string;
      finished?: boolean;
    }) => {
      if (!frame || typeof frame !== "object") {
        return;
      }

      if (process.env.NODE_ENV === "development") {
        console.log(
          "[ws json]",
          frame.type,
          frame.source || "",
          frame.modality || "",
          typeof frame.content === "string" ? frame.content.slice(0, 80) : ""
        );
      }

      if (frame.type === "start") {
        transcriptTextSourceRef.current = null;
        // Do not reset wsInputThisTurn — backend sends start when agent replies.
        return;
      }

      if (frame.type === "data" && frame.modality === "text") {
        const text = frame.content;
        const source = frame.source || "";

        // Primary: user's speech → text (audio-to-text)
        if (source === "input_transcription") {
          if (text) {
            wsInputThisTurnRef.current = true;
            transcriptTextSourceRef.current = "input";
            applyInputTranscription(text, !!frame.finished);
          }
          return;
        }

        // Text-routing fallback: model transcript on text channel
        // (same as live_transcriber.html — only when no input_transcription this turn)
        if (
          text != null &&
          (source === "output" || source === "output_transcription" || !source)
        ) {
          if (!wsInputThisTurnRef.current) {
            transcriptTextSourceRef.current = source || "output";
            setTranscriptText(text, { append: true });
          }
          return;
        }
        return;
      }

      if (frame.type === "data" && frame.modality === "audio") {
        return;
      }

      if (frame.type === "end") {
        finishCurrentTurn();
        wsInputThisTurnRef.current = false;
        transcriptTextSourceRef.current = null;
        return;
      }

      if (frame.type === "error") {
        callbacksRef.current.onError(`socket-error:${frame.message || "Agent error"}`);
      }
    },
    [applyInputTranscription, finishCurrentTurn, setTranscriptText]
  );

  const closeSocket = useCallback(() => {
    const socket = wsRef.current;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "cleanup");
      }
    }
    wsRef.current = null;
    audioStartedRef.current = false;
  }, []);

  const mintLiveSession = useCallback(async () => {
    sessionIdRef.current = sessionIdRef.current || createSessionId();

    const response = await apiFetch("/api/live-transcriber/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionIdRef.current,
        user_id: "ai-scribe-browser",
      }),
    });

    const sessionInfo = (await response.json()) as LiveSessionResponse;
    if (!response.ok) {
      throw new Error(sessionInfo.error || "Failed to mint live session");
    }

    sessionIdRef.current = sessionInfo.session_id || sessionIdRef.current;
    callbacksRef.current.onSessionId?.(sessionIdRef.current);
    return sessionInfo;
  }, []);

  const stopAudioCapture = useCallback(() => {
    audioSendingEnabledRef.current = false;
    stopSpeechMonitor();

    recorderNodeRef.current?.disconnect();
    analyserRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());

    recorderNodeRef.current = null;
    analyserRef.current = null;
    micStreamRef.current = null;

    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }, [stopSpeechMonitor]);

  const connectRef = useRef<(() => Promise<void>) | null>(null);

  const scheduleReconnect = useCallback(() => {
    if (!sessionActiveRef.current || manualCloseRef.current) {
      return;
    }

    reconnectAttemptRef.current += 1;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.min(reconnectAttemptRef.current, 10),
      RECONNECT_MAX_DELAY_MS
    );

    callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: true });
    // Badge: Connection Interrupted / Trying to reconnect…
    callbacksRef.current.onError("socket-reconnecting");

    stopReconnectTimer();
    reconnectTimerRef.current = setTimeout(() => {
      void connectRef.current?.();
    }, delay);
  }, [stopReconnectTimer]);

  const openWebSocket = useCallback(
    (sessionInfo: LiveSessionResponse) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(sessionInfo.wss_url);
        socket.binaryType = "arraybuffer";
        wsRef.current = socket;

        let settled = false;

        socket.onopen = () => {
          socket.send(
            JSON.stringify({
              type: "auth",
              live_token: sessionInfo.live_token,
              session_id: sessionIdRef.current,
              protocol_version: sessionInfo.protocol_version ?? PROTOCOL_VERSION,
            })
          );
          socket.send(
            JSON.stringify({
              type: "start",
              modality: "audio",
              mime_type: "audio/pcm;rate=16000",
              protocol_version: PROTOCOL_VERSION,
            })
          );

          audioStartedRef.current = true;
          setTimeout(() => sendAudioPcm(silentPcmBytes(SILENT_PCM_MS)), 30);
          startKeepalive();

          reconnectAttemptRef.current = 0;
          callbacksRef.current.onConnectionState({ isConnected: true, isConnecting: false });
          callbacksRef.current.onClearError?.("socket-");

          if (!settled) {
            settled = true;
            resolve();
          }
        };

        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
            return;
          }
          if (typeof event.data !== "string") {
            return;
          }

          let frame: {
            type?: string;
            modality?: string;
            source?: string;
            content?: string;
            message?: string;
            finished?: boolean;
          };
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }

          handleWsJsonFrame(frame);
        };

        socket.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error("WebSocket connection failed"));
          }
        };

        socket.onclose = () => {
          if (wsRef.current === socket) {
            wsRef.current = null;
          }

          stopKeepalive();
          audioStartedRef.current = false;

          if (manualCloseRef.current || !sessionActiveRef.current) {
            callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: false });
            return;
          }

          // Keep mic/recording UI running; show disconnected badge and retry WS.
          scheduleReconnect();
        };
      }),
    [handleWsJsonFrame, scheduleReconnect, sendAudioPcm, startKeepalive, stopKeepalive]
  );

  const startAudioCapture = useCallback(async () => {
    try {
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioCtxRef.current = new AudioContext({
        sampleRate: INPUT_AUDIO_RATE,
        latencyHint: "interactive",
      });

      await audioCtxRef.current.audioWorklet.addModule(getWorkletUrl());

      const source = audioCtxRef.current.createMediaStreamSource(micStreamRef.current);
      analyserRef.current = audioCtxRef.current.createAnalyser();
      analyserRef.current.fftSize = 1024;
      source.connect(analyserRef.current);

      const recorderNode = new AudioWorkletNode(audioCtxRef.current, "pcm-recorder-processor");
      recorderNode.port.onmessage = (event) => {
        if (!(event.data instanceof ArrayBuffer)) {
          return;
        }
        if (!audioSendingEnabledRef.current) {
          return;
        }
        sendAudioPcm(new Uint8Array(event.data));
      };

      analyserRef.current.connect(recorderNode);
      const silentGain = audioCtxRef.current.createGain();
      silentGain.gain.value = 0;
      recorderNode.connect(silentGain);
      silentGain.connect(audioCtxRef.current.destination);
      recorderNodeRef.current = recorderNode;

      if (audioCtxRef.current.state === "suspended") {
        await audioCtxRef.current.resume();
      }

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to access microphone";
      callbacksRef.current.onError(`mic-error:${message}`);
      return false;
    }
  }, [sendAudioPcm]);

  const startSendingAudio = useCallback(() => {
    audioSendingEnabledRef.current = true;
    startSpeechMonitor();
  }, [startSpeechMonitor]);

  const pauseSendingAudio = useCallback(() => {
    audioSendingEnabledRef.current = false;
    stopSpeechMonitor();
  }, [stopSpeechMonitor]);

  const resumeSendingAudio = useCallback(() => {
    audioSendingEnabledRef.current = true;
    startSpeechMonitor();
  }, [startSpeechMonitor]);

  const connect = useCallback(async () => {
    if (!sessionActiveRef.current) {
      return;
    }

    stopReconnectTimer();
    callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: true });

    try {
      const sessionInfo = await mintLiveSession();
      await openWebSocket(sessionInfo);
    } catch (error) {
      if (!sessionActiveRef.current || manualCloseRef.current) {
        callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: false });
        return;
      }

      const message = error instanceof Error ? error.message : "Unable to connect live socket";
      callbacksRef.current.onError(`socket-connect:${message}`);
      scheduleReconnect();
    }
  }, [mintLiveSession, openWebSocket, scheduleReconnect, stopReconnectTimer]);

  connectRef.current = connect;

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    sessionActiveRef.current = false;
    audioSendingEnabledRef.current = false;
    audioStartedRef.current = false;
    wsInputThisTurnRef.current = false;

    stopReconnectTimer();
    stopKeepalive();
    stopSpeechMonitor();
    closeSocket();

    finishCurrentTurn();
    transcriptTextSourceRef.current = null;
    callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: false });
  }, [closeSocket, finishCurrentTurn, stopKeepalive, stopReconnectTimer, stopSpeechMonitor]);

  /**
   * Same order as live_transcriber.html `startSession`:
   * mic first → mint session + open WS → start sending.
   */
  const startTranscription = useCallback(async (): Promise<boolean> => {
    manualCloseRef.current = false;
    sessionActiveRef.current = true;
    reconnectAttemptRef.current = 0;
    sessionIdRef.current = createSessionId();
    currentTurnTextRef.current = "";
    completedTranscriptRef.current = "";
    transcriptTextSourceRef.current = null;
    wsInputThisTurnRef.current = false;
    callbacksRef.current.onLiveDraft("");

    const micStarted = await startAudioCapture();
    if (!micStarted) {
      sessionActiveRef.current = false;
      return false;
    }

    try {
      await connect();
      startSendingAudio();
      return true;
    } catch (error) {
      console.error("Start failed:", error);
      const message = error instanceof Error ? error.message : "Failed to start live transcription";
      stopReconnectTimer();
      stopAudioCapture();
      closeSocket();
      sessionActiveRef.current = false;
      callbacksRef.current.onConnectionState({ isConnected: false, isConnecting: false });
      callbacksRef.current.onError(`socket-connect:${message}`);
      return false;
    }
  }, [closeSocket, connect, startAudioCapture, startSendingAudio, stopAudioCapture, stopReconnectTimer]);

  /** Commit open draft without firing onTurnComplete (caller adds to Redux). */
  const flushDraft = useCallback(() => {
    const draft = currentTurnTextRef.current.trim();
    if (draft) {
      completedTranscriptRef.current +=
        (completedTranscriptRef.current ? "\n" : "") + draft;
    }
    currentTurnTextRef.current = "";
    transcriptTextSourceRef.current = null;
    callbacksRef.current.onLiveDraft("");
    return draft;
  }, []);

  useEffect(() => {
    return () => {
      manualCloseRef.current = true;
      sessionActiveRef.current = false;
      stopReconnectTimer();
      stopKeepalive();
      stopSpeechMonitor();
      closeSocket();
      stopAudioCapture();
    };
  }, [closeSocket, stopAudioCapture, stopKeepalive, stopReconnectTimer, stopSpeechMonitor]);

  return {
    startTranscription,
    disconnect,
    startAudioCapture,
    stopAudioCapture,
    startSendingAudio,
    pauseSendingAudio,
    resumeSendingAudio,
    flushDraft,
    isSessionActive: () => sessionActiveRef.current,
  };
}
