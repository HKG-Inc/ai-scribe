import {
  EDGE_SILENCE_CHUNKS,
  KEEP_SILENCE_CHUNKS,
  PCM_CHUNK_SAMPLES,
  PCM_SEND_GAP_MS,
  REPLY_TRAILING_SILENCE_MS,
} from "@/lib/questionnaire/constants";
import { withBasePath } from "@/lib/utils";

export const TARGET_PCM_SAMPLE_RATE = 16000;

export function pcmRms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) {
    sumSq += pcm[i] * pcm[i];
  }
  return Math.sqrt(sumSq / pcm.length);
}

export function resamplePcm16(
  pcm: Int16Array,
  fromRate: number,
  toRate: number
): Int16Array {
  if (fromRate === toRate || !pcm.length) return pcm;

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(pcm.length / ratio));
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const s0 = pcm[idx] ?? 0;
    const s1 = pcm[Math.min(idx + 1, pcm.length - 1)] ?? s0;
    out[i] = Math.round(s0 + frac * (s1 - s0));
  }

  return out;
}

export function concatInt16(parts: Int16Array[]): Int16Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunkRms(chunk: Int16Array): number {
  if (!chunk.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < chunk.length; i++) {
    sumSq += chunk[i] * chunk[i];
  }
  return Math.sqrt(sumSq / chunk.length);
}

function silenceThreshold(parts: Int16Array[]): number {
  const rmsValues = parts.map(chunkRms).sort((a, b) => a - b);
  const p20 = rmsValues[Math.floor(rmsValues.length * 0.2)] || 0;
  return Math.max(250, Math.min(1400, p20 * 2.5));
}

export function compressSilenceChunks(parts: Int16Array[]): {
  parts: Int16Array[];
  droppedMs: number;
} {
  if (!parts.length) {
    return { parts: [], droppedMs: 0 };
  }

  const thresh = silenceThreshold(parts);
  const kept: Int16Array[] = [];
  let run = 0;
  let droppedChunks = 0;

  for (const chunk of parts) {
    if (chunkRms(chunk) < thresh) {
      run += 1;
      if (run <= KEEP_SILENCE_CHUNKS) kept.push(chunk);
      else droppedChunks += 1;
    } else {
      run = 0;
      kept.push(chunk);
    }
  }

  let start = 0;
  while (start < kept.length && chunkRms(kept[start]) < thresh) start += 1;
  start = Math.max(0, start - EDGE_SILENCE_CHUNKS);

  let end = kept.length;
  while (end > start && chunkRms(kept[end - 1]) < thresh) end -= 1;
  end = Math.min(kept.length, end + EDGE_SILENCE_CHUNKS);

  droppedChunks += start + (kept.length - end);
  const trimmed = kept.slice(start, end);

  return {
    parts: trimmed.length ? trimmed : parts,
    droppedMs: droppedChunks * 20,
  };
}

export function splitIntoSendChunks(pcm: Int16Array): Int16Array[] {
  const chunks: Int16Array[] = [];
  for (let i = 0; i < pcm.length; i += PCM_CHUNK_SAMPLES) {
    chunks.push(pcm.subarray(i, i + PCM_CHUNK_SAMPLES));
  }
  return chunks;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ReplyStructured {
  original: string;
  english: string;
  language: string;
}

export function isEmptyReply(reply: ReplyStructured | null): boolean {
  if (!reply) return true;
  const blob = [reply.original, reply.english, reply.language].join(" ");
  return /NO_SPEECH|AUDIO_TOO_QUIET|NO_CLEAR_SPEECH/i.test(blob);
}

export function hasUsableReply(reply: ReplyStructured | null): boolean {
  return Boolean(reply?.english?.trim() && !isEmptyReply(reply));
}

export function hasFullReply(reply: ReplyStructured | null): boolean {
  return hasUsableReply(reply);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function structuredFromRecord(record: Record<string, unknown>): ReplyStructured | null {
  const english = record.english ?? record.english_translation;
  if (typeof english !== "string" || !english.trim()) {
    return null;
  }

  const original =
    typeof record.original === "string"
      ? record.original
      : typeof record.original_text === "string"
        ? record.original_text
        : "";

  const language = typeof record.language === "string" ? record.language : "";

  return {
    original,
    english: english.trim(),
    language,
  };
}

function findStructuredReply(value: unknown, depth = 0): ReplyStructured | null {
  if (depth > 6 || value == null) return null;

  const parsed = parseMaybeJson(value);
  if (typeof parsed === "string") return null;

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findStructuredReply(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;
  const direct = structuredFromRecord(record);
  if (direct) return direct;

  for (const key of ["args", "content", "result", "data", "payload", "output"]) {
    const found = findStructuredReply(record[key], depth + 1);
    if (found) return found;
  }

  return null;
}

export function joinReplyText(prev: string, next: string): string {
  const a = (prev || "").trim();
  const b = (next || "").trim();
  if (!b) return a;
  if (!a) return b;
  if (a === b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a} ${b}`;
}

export function extractStructured(event: Record<string, unknown>): ReplyStructured | null {
  const direct = findStructuredReply(event);
  if (direct) return direct;

  if (event.type === "tool_call" || event.type === "function_call") {
    const toolArgs = parseMaybeJson(event.args ?? event.arguments);
    return findStructuredReply(toolArgs);
  }

  if (event.type === "data" && typeof event.content === "string") {
    return findStructuredReply(event.content);
  }

  return null;
}

/** Whether a live WS frame should be treated as a questionnaire answer transcription. */
export function shouldAcceptReplyEvent(event: Record<string, unknown>): boolean {
  if (event.type === "tool_call" || event.type === "function_call") {
    const name = event.name ?? event.tool;
    return name === "emit_transcription";
  }

  if (
    event.type === "data" &&
    event.modality === "text" &&
    event.partial !== true &&
    typeof event.content === "string"
  ) {
    const source = event.source;
    return source === "output" || source === "output_transcription" || !source;
  }

  return false;
}

export interface ParsedLiveEvent {
  binary?: ArrayBuffer;
  type?: string;
  modality?: string;
  source?: string;
  content?: string;
  finished?: boolean;
  partial?: boolean;
  interrupted?: boolean;
  message?: string;
  name?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export function parseLiveEvent(data: string | ArrayBuffer | Blob): ParsedLiveEvent {
  if (data instanceof ArrayBuffer) {
    return { binary: data };
  }
  if (data instanceof Blob) {
    return { binary: undefined };
  }
  try {
    return JSON.parse(data) as ParsedLiveEvent;
  } catch {
    return {};
  }
}

export function isSocketOpen(ws: WebSocket | null): boolean {
  return !!ws && ws.readyState === WebSocket.OPEN;
}

export interface LiveSessionInfo {
  session_id: string;
  wss_url: string;
  live_token: string;
  protocol_version?: number;
}

export async function mintQuestionnaireLiveSession(
  agentSlug: string,
  sessionId?: string
): Promise<LiveSessionInfo> {
  const { apiFetch } = await import("@/lib/utils");
  const response = await apiFetch("/api/questionnaire/live/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_slug: agentSlug,
      session_id: sessionId,
    }),
  });

  const data = (await response.json()) as LiveSessionInfo & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || "Failed to mint questionnaire live session");
  }
  return data;
}

export async function connectLiveSocket(session: LiveSessionInfo): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(session.wss_url);
    ws.binaryType = "arraybuffer";
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            type: "auth",
            live_token: session.live_token,
            session_id: session.session_id,
            protocol_version: session.protocol_version ?? 2,
          })
        );
        settled = true;
        resolve(ws);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Failed to send live auth"));
      }
    };

    ws.onerror = () => {
      fail(new Error("Live WebSocket connection failed"));
    };

    ws.onclose = (event) => {
      if (!settled) {
        fail(new Error(`Live WebSocket closed before ready (${event.code})`));
      }
    };
  });
}

export function startTurn(
  ws: WebSocket,
  modality: "text" | "audio",
  mimeType?: string
): void {
  ws.send(
    JSON.stringify({
      type: "start",
      modality,
      ...(mimeType ? { mime_type: mimeType } : {}),
      protocol_version: 2,
    })
  );
}

export function sendText(ws: WebSocket, text: string): void {
  ws.send(
    JSON.stringify({
      type: "data",
      modality: "text",
      content: text,
    })
  );
}

export function sendPcm(ws: WebSocket, chunk: Int16Array): void {
  ws.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
}

export function getPcmRecorderWorkletUrl(): string {
  if (typeof window === "undefined") {
    return "/pcm-recorder-processor.js";
  }
  return `${window.location.origin}${withBasePath("/pcm-recorder-processor.js")}`;
}

export function getPcmPlayerWorkletUrl(): string {
  if (typeof window === "undefined") {
    return "/pcm-player-processor.js";
  }
  return `${window.location.origin}${withBasePath("/pcm-player-processor.js")}`;
}

export function silentPcmChunk(samples = PCM_CHUNK_SAMPLES): Int16Array {
  return new Int16Array(samples);
}

/**
 * Send ~durationMs of silence so the agent can detect a pause and emit
 * transcription before the turn ends. User does not need to stay quiet.
 */
export async function sendTrailingSilence(
  ws: WebSocket,
  durationMs = REPLY_TRAILING_SILENCE_MS,
  gapMs = PCM_SEND_GAP_MS
): Promise<void> {
  const chunkCount = Math.max(1, Math.round(durationMs / Math.max(gapMs, 1)));
  const silence = silentPcmChunk();
  for (let i = 0; i < chunkCount; i++) {
    if (!isSocketOpen(ws)) {
      throw new Error("Live session closed while sending trailing silence");
    }
    sendPcm(ws, silence);
    if (gapMs > 0 && i < chunkCount - 1) {
      await sleep(gapMs);
    }
  }
}

/** Replay buffered PCM to the live agent in real-time sized chunks. */
export async function sendRecordedPcmStream(
  ws: WebSocket,
  pcm: Int16Array,
  gapMs = PCM_SEND_GAP_MS
): Promise<void> {
  if (!pcm.length) return;

  const chunks = splitIntoSendChunks(pcm);
  for (let i = 0; i < chunks.length; i++) {
    if (!isSocketOpen(ws)) {
      throw new Error("Live session closed before recorded audio finished sending");
    }
    sendPcm(ws, chunks[i]);
    if (gapMs > 0 && i < chunks.length - 1) {
      await sleep(gapMs);
    }
  }
}

export function endTurn(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: "end" }));
}

export function disconnectLive(ws: WebSocket | null): void {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "disconnect");
    }
  } catch {
    // ignore
  }
}
