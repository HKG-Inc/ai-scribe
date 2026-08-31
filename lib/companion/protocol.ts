export const DEFAULT_RELAY_URL =
  "wss://hikigai-websocket-1-3ecbb3c6.apps.hikigaiplatform.io/relay";
export const DEFAULT_RELAY_TOKEN = "9c82c2eb-0c7f-47dc-b52f-e8b958c21a41";

/** Browser WebSocket needs wss:// (or ws://); allow https:// in env for convenience. */
export function toWebSocketUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }
  return trimmed;
}

export const TRANSCRIPT_KIND = "carepilot-live-transcript";
/** Wire sender the companion app already understands. */
export const WEB_SENDER = "carepilot";
export const COMPANION_SENDER = "companion";

export const HELLO_INTERVAL_MS = 20_000;
export const RELAY_MAX_RECONNECT_ATTEMPTS = 8;
export const RELAY_FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4400, 4401]);

export type TranscriptRelayStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "joined"
  | "reconnecting"
  | "closed"
  | "error";

export type RecordingControlAction = "pause" | "resume" | "stop";

/**
 * Why the visit ended. Carried for the companion's logs and for future wording
 * on the phone; it has no effect on what the phone does today.
 */
export type VisitEndedReason = "ended-by-doctor";

/**
 * Wire events on the companion relay. Same contract as CarePilot
 * (`lib/models/visitTranscriptRelay.ts`).
 */
export const TRANSCRIPT_EVENTS = {
  /** Web → companion: "I'm here, send me your current transcript." */
  hello: "transcript.hello",
  /** Companion → web: full snapshot. Authoritative; replaces everything. */
  state: "transcript.state",
  /** Companion → web: the in-progress utterance only. */
  partial: "transcript.partial",
  /** Companion → web: recording ended, with the final lines. */
  stopped: "transcript.stopped",
  /**
   * Web → companion: pause/resume/stop the phone's recording. The phone
   * applies it and then publishes its resulting state.
   */
  control: "recording.control",
  /**
   * Web → companion: the doctor pressed End Visit; this consultation is
   * over. Distinct from a `stop` control, which only ends the recording and
   * leaves the phone on the visit ready to record again.
   */
  visitEnded: "visit.ended",
} as const;

export type TranscriptStateData = {
  lines: string[];
  pending: string;
  recording: boolean;
  paused: boolean;
};

export type TranscriptPartialData = {
  pending: string;
};

export type TranscriptStoppedData = {
  lines: string[];
};

export type RecordingControlData = {
  action: RecordingControlAction;
};

export type VisitEndedData = {
  reason: VisitEndedReason;
};

export type CompanionRecordingSignal = {
  recording: boolean;
  paused: boolean;
  lines: string[];
};

export type VisitTranscriptEvent =
  (typeof TRANSCRIPT_EVENTS)[keyof typeof TRANSCRIPT_EVENTS];

export type VisitTranscriptPayload = {
  kind: typeof TRANSCRIPT_KIND;
  visitId: string;
  event: VisitTranscriptEvent;
  data: Record<string, unknown>;
  sender: string;
  sentAt: number;
};

export type RelayAuthFrame = {
  type: "auth";
  role: "listener";
  doctor_id: string;
  token: string;
  session: string;
};

export type RelayJsonEnvelope = {
  type: "json";
  payload: VisitTranscriptPayload;
};

export function transcriptRelayConfig() {
  return {
    url: toWebSocketUrl(
      process.env.NEXT_PUBLIC_HIKIGAI_CONNECT_URL || DEFAULT_RELAY_URL
    ),
    token: process.env.NEXT_PUBLIC_HIKIGAI_CONNECT_TOKEN || DEFAULT_RELAY_TOKEN,
  };
}

export function relayReconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(500 * (attempt - 1), 8000);
}

/** Placeholder until AI Scribe has a real patient id. The companion app requires this field. */
export const HARDCODED_PATIENT_ID = "patient-001";

export function buildVisitQrPayload(doctorId: string, visitId: string): string {
  return JSON.stringify({
    type: "carepilot.visit",
    v: 1,
    patientId: HARDCODED_PATIENT_ID,
    doctorId,
    visitId,
  });
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
