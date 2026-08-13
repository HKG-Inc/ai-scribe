export const DEFAULT_RELAY_URL =
  "wss://hikigai-websocket-bb3ecd8d.apps.hikigaiplatform.io/relay";
export const DEFAULT_RELAY_TOKEN = "9c82c2eb-0c7f-47dc-b52f-e8b958c21a41";

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

export type VisitEndedReason = "ended-by-doctor";

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
  | "transcript.state"
  | "transcript.partial"
  | "transcript.stopped"
  | "transcript.hello"
  | "recording.control"
  | "visit.ended";

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
    url: process.env.NEXT_PUBLIC_HIKIGAI_CONNECT_URL || DEFAULT_RELAY_URL,
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
