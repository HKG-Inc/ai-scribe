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
  return `Translate to ${languageName}: ${englishQuestion}`;
}
