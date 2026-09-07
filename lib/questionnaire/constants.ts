export const QUESTIONNAIRE_PLAY_AGENT =
  process.env.QUESTIONNAIRE_PLAY_AGENT || "questionnaire-agent";

export const QUESTIONNAIRE_REPLY_AGENT =
  process.env.QUESTIONNAIRE_REPLY_AGENT || "questionnaire-reply-agent";

export const PCM_CHUNK_SAMPLES = 320;
export const PCM_SEND_GAP_MS = 20;
export const KEEP_SILENCE_CHUNKS = 10;
export const EDGE_SILENCE_CHUNKS = 2;
export const MIN_ANSWER_SAMPLES = 1600;
/** Auto silence appended after stop so the agent can detect pause (~0.8s). */
export const REPLY_TRAILING_SILENCE_MS = 1500;
export const REPLY_QUIET_MS = 1800;
export const REPLY_MAX_WAIT_MS = 10000;
export const PROTOCOL_VERSION = 2;

export function languageNameForPrompt(code: string, label?: string): string {
  if (label) {
    return label.split("/")[0]?.trim() || code;
  }
  return code;
}

export function buildPlayAgentPrompt(languageName: string, englishQuestion: string): string {
  return (
    `Translate this clinical intake question into ${languageName}. ` +
    "Reply with ONLY the translated question — no labels, keys, quotes, or explanation.\n\n" +
    englishQuestion
  );
}

/**
 * Clean play-agent text that sometimes arrives as JSON or
 * "…translated_text…" duplicates instead of plain translation.
 */
export function normalizePlayTranslation(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const candidate =
          record.translated_text ??
          record.translation ??
          record.text ??
          record.content ??
          record.output;
        if (typeof candidate === "string" && candidate.trim()) {
          return normalizePlayTranslation(candidate);
        }
      }
    } catch {
      // fall through
    }
  }

  const labelPattern = /\btranslated_text\b\s*:?\s*/i;
  if (labelPattern.test(trimmed)) {
    const parts = trimmed
      .split(labelPattern)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0];

    const normalizeComparable = (value: string) =>
      value.replace(/[—–\-.…\s]+$/g, "").replace(/\s+/g, " ").trim();

    let best = parts[parts.length - 1];
    for (const part of parts) {
      const a = normalizeComparable(best);
      const b = normalizeComparable(part);
      if (!a) {
        best = part;
        continue;
      }
      if (!b) continue;
      if (a === b || a.includes(b) || b.includes(a)) {
        best = part.length >= best.length ? part : best;
      } else if (part.length > best.length) {
        best = part;
      }
    }
    return best;
  }

  return trimmed;
}

/** Hint sent on Stop before trailing silence / endTurn so ASR keeps native script. */
export function buildReplyLanguageHint(languageCode: string, languageName: string): string {
  return (
    `The patient is responding in ${languageName} (${languageCode}). ` +
    "Listen carefully and transcribe exactly what is said in the audio."
  );
}
