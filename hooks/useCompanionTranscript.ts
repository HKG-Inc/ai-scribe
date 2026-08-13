"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  asBoolean,
  asString,
  asStringArray,
  transcriptRelayConfig,
  type CompanionRecordingSignal,
  type RecordingControlAction,
  type TranscriptRelayStatus,
  type VisitEndedReason,
  type VisitTranscriptPayload,
} from "@/lib/companion/protocol";
import { VisitTranscriptRelay } from "@/lib/companion/relay";

type UseCompanionTranscriptOptions = {
  onRecordingChange?: (signal: CompanionRecordingSignal) => void;
};

export function useCompanionTranscript(
  visitId: string | null,
  doctorId: string,
  options?: UseCompanionTranscriptOptions
) {
  const [lines, setLines] = useState<string[]>([]);
  const [pendingText, setPendingText] = useState("");
  const [active, setActive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<TranscriptRelayStatus>("idle");
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);

  const linesRef = useRef<string[]>([]);
  const recordingRef = useRef(false);
  const pausedRef = useRef(false);
  const relayRef = useRef<VisitTranscriptRelay | null>(null);
  const onRecordingChangeRef = useRef(options?.onRecordingChange);

  onRecordingChangeRef.current = options?.onRecordingChange;

  const resetLocalState = useCallback(() => {
    linesRef.current = [];
    recordingRef.current = false;
    pausedRef.current = false;
    setLines([]);
    setPendingText("");
    setActive(false);
    setRecording(false);
    setPaused(false);
    setLastFrameAt(null);
  }, []);

  const emitRecordingChange = useCallback(
    (nextRecording: boolean, nextPaused: boolean, nextLines: string[]) => {
      if (recordingRef.current === nextRecording && pausedRef.current === nextPaused) {
        return;
      }
      recordingRef.current = nextRecording;
      pausedRef.current = nextPaused;
      setRecording(nextRecording);
      setPaused(nextPaused);
      onRecordingChangeRef.current?.({
        recording: nextRecording,
        paused: nextPaused,
        lines: nextLines,
      });
    },
    []
  );

  const handleFrame = useCallback(
    (payload: VisitTranscriptPayload) => {
      setActive(true);
      setLastFrameAt(payload.sentAt || Date.now());

      if (payload.event === "transcript.state") {
        const nextLines = asStringArray(payload.data.lines);
        const nextPending = asString(payload.data.pending);
        const nextRecording = asBoolean(payload.data.recording);
        const nextPaused = asBoolean(payload.data.paused);
        linesRef.current = nextLines;
        setLines(nextLines);
        setPendingText(nextPending);
        emitRecordingChange(nextRecording, nextPaused, nextLines);
        return;
      }

      if (payload.event === "transcript.partial") {
        setPendingText(asString(payload.data.pending));
        return;
      }

      if (payload.event === "transcript.stopped") {
        const nextLines = asStringArray(payload.data.lines);
        linesRef.current = nextLines;
        setLines(nextLines);
        setPendingText("");
        emitRecordingChange(false, false, nextLines);
      }
    },
    [emitRecordingChange]
  );

  useEffect(() => {
    if (!visitId || !doctorId) {
      relayRef.current?.dispose();
      relayRef.current = null;
      resetLocalState();
      setStatus("idle");
      return;
    }

    const { url, token } = transcriptRelayConfig();
    const relay = new VisitTranscriptRelay({
      url,
      doctorId,
      token,
      visitId,
      callbacks: {
        onStatus: setStatus,
        onReady: () => {
          relay.publish("transcript.hello");
        },
        onFrame: handleFrame,
        onError: (message) => {
          console.error("[companion-relay]", message);
        },
      },
    });

    relayRef.current = relay;
    resetLocalState();
    relay.connect();

    return () => {
      relay.dispose();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [visitId, doctorId, handleFrame, resetLocalState]);

  const sendControl = useCallback((action: RecordingControlAction) => {
    relayRef.current?.publish("recording.control", { action });
  }, []);

  const endVisit = useCallback((reason: VisitEndedReason = "ended-by-doctor") => {
    relayRef.current?.publish("visit.ended", { reason });
  }, []);

  return {
    lines,
    pendingText,
    active,
    recording,
    paused,
    status,
    lastFrameAt,
    sendControl,
    endVisit,
  };
}
