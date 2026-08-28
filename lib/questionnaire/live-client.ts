import {
  EDGE_SILENCE_CHUNKS,
  KEEP_SILENCE_CHUNKS,
  PCM_CHUNK_SAMPLES,
} from "@/lib/questionnaire/constants";

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

export function hasFullReply(reply: ReplyStructured | null): boolean {
  return Boolean(reply && reply.english && reply.language && !isEmptyReply(reply));
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
  const args =
    (event.args as Record<string, unknown> | undefined) ||
    ((event.content as Record<string, unknown> | undefined)?.args as
      | Record<string, unknown>
      | undefined);

  if (args && typeof args.english === "string") {
    return {
      original: typeof args.original === "string" ? args.original : "",
      english: args.english,
      language: typeof args.language === "string" ? args.language : "",
    };
  }

  if (event.type === "tool_call" && typeof event.name === "string") {
    const toolArgs = event.args as Record<string, unknown> | undefined;
    if (toolArgs && typeof toolArgs.english === "string") {
      return {
        original: typeof toolArgs.original === "string" ? toolArgs.original : "",
        english: toolArgs.english,
        language: typeof toolArgs.language === "string" ? toolArgs.language : "",
      };
    }
  }

  return null;
}

export interface ParsedLiveEvent {
  binary?: ArrayBuffer;
  type?: string;
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

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "auth",
          live_token: session.live_token,
          session_id: session.session_id,
          protocol_version: session.protocol_version ?? 2,
        })
      );
      resolve(ws);
    };

    ws.onerror = () => reject(new Error("Live WebSocket connection failed"));
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
