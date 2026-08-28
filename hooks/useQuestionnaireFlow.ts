"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  PARENT_LANGUAGE,
  QUESTIONS,
  languageLabel,
  type Question,
} from "@/lib/conversation-mode";
import {
  QUESTIONNAIRE_PLAY_AGENT,
  QUESTIONNAIRE_REPLY_AGENT,
  PCM_SEND_GAP_MS,
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
  hasFullReply,
  isSocketOpen,
  joinReplyText,
  mintQuestionnaireLiveSession,
  parseLiveEvent,
  sendPcm,
  sendText,
  splitIntoSendChunks,
  sleep,
  startTurn,
  type LiveSessionInfo,
  type ReplyStructured,
} from "@/lib/questionnaire/live-client";
import { apiFetch, withBasePath } from "@/lib/utils";

interface CannedQuestionResponse {
  available: boolean;
  text?: string;
  original_text?: string;
  wav_url?: string;
}

async function fetchCannedQuestion(
  language: string,
  questionId: string
): Promise<CannedQuestionResponse> {
  const params = new URLSearchParams({ language, question_id: questionId });
  const response = await apiFetch(`/api/questionnaire/canned?${params.toString()}`);
  return (await response.json()) as CannedQuestionResponse;
}

async function playWavUrl(wavUrl: string, signal: AbortSignal): Promise<void> {
  const proxyUrl = withBasePath(
    `/api/questionnaire/proxy-audio?url=${encodeURIComponent(wavUrl)}`
  );
  const response = await fetch(proxyUrl, { signal });
  if (!response.ok) {
    throw new Error("Failed to load canned question audio");
  }
  const buffer = await response.arrayBuffer();
  const audioContext = new AudioContext();
  try {
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    await audioContext.resume();
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.onended = () => resolve();
      const onAbort = () => {
        try {
          source.stop();
        } catch {
          // ignore
        }
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      source.start(0);
    });
  } finally {
    await audioContext.close();
  }
}

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
  const pcmPartsRef = useRef<Int16Array[]>([]);
  const replySegmentsRef = useRef<ReplyStructured[]>([]);
  const replyStructuredRef = useRef<ReplyStructured | null>(null);
  const replyAbortRef = useRef(false);

  const ensurePlayer = useCallback(async () => {
    if (playerNodeRef.current) return;
    playerCtxRef.current = new AudioContext({ sampleRate: 24000 });
    await playerCtxRef.current.audioWorklet.addModule(
      withBasePath("/pcm-player-processor.js")
    );
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

  const playViaAgent = useCallback(
    async (question: Question, language: string, signal: AbortSignal) => {
      await ensurePlayer();
      playerNodeRef.current?.port.postMessage({ command: "reset" });

      const prompt = buildPlayAgentPrompt(
        languageNameForPrompt(language, languageLabel(language)),
        question.text_en
      );

      const ws = await ensureAudioLive(QUESTIONNAIRE_PLAY_AGENT);

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
    },
    [ensureAudioLive, ensurePlayer]
  );

  const playQuestion = useCallback(
    async (
      questionIndex: number,
      language: string
    ): Promise<{ translatedText: string; usedCanned: boolean }> => {
      const question = QUESTIONS[questionIndex];
      if (!question) {
        throw new Error("Question not found");
      }

      cancelPlay();
      const controller = new AbortController();
      playAbortRef.current = controller;

      let translatedText = "";
      let usedCanned = false;

      const canned = await fetchCannedQuestion(language, question.id);
      if (canned.available && canned.text && canned.wav_url) {
        translatedText = canned.text;
        usedCanned = true;
        await playWavUrl(canned.wav_url, controller.signal);
      } else {
        await playViaAgent(question, language, controller.signal);
        translatedText =
          language === PARENT_LANGUAGE ? question.text_en : "";
      }

      playAbortRef.current = null;
      return { translatedText, usedCanned };
    },
    [cancelPlay, playViaAgent]
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
    pcmPartsRef.current = [];
    replyStructuredRef.current = null;
    replySegmentsRef.current = [];
    replyAbortRef.current = false;

    recStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    recCtxRef.current = new AudioContext({ sampleRate: 16000 });
    await recCtxRef.current.audioWorklet.addModule(
      withBasePath("/pcm-recorder-processor.js")
    );
    recNodeRef.current = new AudioWorkletNode(recCtxRef.current, "pcm-recorder-processor");
    recCtxRef.current.createMediaStreamSource(recStreamRef.current).connect(recNodeRef.current);
    recNodeRef.current.port.onmessage = (event) => {
      pcmPartsRef.current.push(new Int16Array(event.data.slice(0)));
    };
  }, [cancelPlay]);

  const rememberReplySegment = useCallback((found: ReplyStructured) => {
    if (!hasFullReply(found)) return;
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

  const openReplyLive = useCallback(async () => {
    replyStructuredRef.current = null;
    replySegmentsRef.current = [];
    replyAbortRef.current = false;

    if (isSocketOpen(replyWsRef.current) && replySessionRef.current) {
      const ws = replyWsRef.current!;
      startTurn(ws, "audio", "audio/pcm;rate=16000");
      return ws;
    }

    disconnectLive(replyWsRef.current);
    replyWsRef.current = null;

    const session = await mintQuestionnaireLiveSession(QUESTIONNAIRE_REPLY_AGENT);
    replySessionRef.current = session;
    const ws = await connectLiveSocket(session);
    replyWsRef.current = ws;

    ws.onmessage = (event) => {
      void (async () => {
        let payload: string | ArrayBuffer = event.data;
        if (payload instanceof Blob) {
          payload = await payload.arrayBuffer();
        }
        const parsed = parseLiveEvent(payload);
        if (parsed.binary) return;
        const found =
          extractStructured(parsed as Record<string, unknown>) ||
          extractStructured({ content: parsed.content });
        if (found) rememberReplySegment(found);
      })();
    };

    ws.addEventListener("close", () => {
      if (replyWsRef.current === ws) {
        replyWsRef.current = null;
      }
    });

    startTurn(ws, "audio", "audio/pcm;rate=16000");
    return ws;
  }, [rememberReplySegment]);

  const waitForReplyQuiet = useCallback(async (): Promise<ReplyStructured | null> => {
    const started = Date.now();
    let lastCount = replySegmentsRef.current.length;
    let lastChange = Date.now();

    while (Date.now() - started < REPLY_MAX_WAIT_MS) {
      if (replyAbortRef.current) break;
      if (replySegmentsRef.current.length !== lastCount) {
        lastCount = replySegmentsRef.current.length;
        lastChange = Date.now();
      }
      if (hasFullReply(replyStructuredRef.current) && Date.now() - lastChange >= REPLY_QUIET_MS) {
        break;
      }
      await sleep(80);
    }

    return replyStructuredRef.current;
  }, []);

  const stopRecordingAndTranscribe = useCallback(async (): Promise<ReplyStructured | null> => {
    stopMic();

    const compressed = compressSilenceChunks(pcmPartsRef.current);
    pcmPartsRef.current = compressed.parts;
    const pcm = concatInt16(pcmPartsRef.current);

    if (pcm.length < MIN_ANSWER_SAMPLES) {
      throw new Error("Recording too short. Speak longer, then stop.");
    }

    const ws = await openReplyLive();
    const chunks = splitIntoSendChunks(pcm);

    for (const chunk of chunks) {
      if (!isSocketOpen(ws) || replyAbortRef.current) break;
      sendPcm(ws, chunk);
      await sleep(PCM_SEND_GAP_MS);
    }

    endTurn(ws);
    return waitForReplyQuiet();
  }, [openReplyLive, stopMic, waitForReplyQuiet]);

  useEffect(() => {
    return () => {
      cancelPlay();
      stopMic();
      disconnectLive(audioWsRef.current);
      disconnectLive(replyWsRef.current);
      if (playerCtxRef.current) {
        void playerCtxRef.current.close();
      }
    };
  }, [cancelPlay, stopMic]);

  return {
    playQuestion,
    cancelPlay,
    startRecording,
    stopRecordingAndTranscribe,
  };
}
