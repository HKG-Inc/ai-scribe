/** BCP-47 codes with pre-recorded GCS WAV + JSON assets. */
export const CANNED_QUESTION_LANGUAGES = new Set([
  "ar-XA",
  "bn-IN",
  "de-DE",
  "en-US",
  "es-ES",
  "fr-FR",
  "gu-IN",
  "hi-IN",
  "it-IT",
  "ja-JP",
  "kn-IN",
  "ko-KP",
  "ml-IN",
  "mr-IN",
  "pl-PL",
  "pt-BR",
  "ru-RU",
  "ta-IN",
  "te-IN",
  "th-TH",
  "uk-UA",
  "vi-VN",
  "zh-CN",
]);

export const GCS_QUESTIONNAIRE_BUCKET =
  process.env.GCS_QUESTIONNAIRE_BUCKET || "multilanguage_question";

export const GCS_SIGNED_URL_TTL_MS = 5 * 60 * 1000;

export const QUESTIONNAIRE_PLAY_AGENT =
  process.env.QUESTIONNAIRE_PLAY_AGENT || "questionnaire-agent";

export const QUESTIONNAIRE_REPLY_AGENT =
  process.env.QUESTIONNAIRE_REPLY_AGENT || "questionnaire-reply-agent";

export const PCM_CHUNK_SAMPLES = 320;
export const PCM_SEND_GAP_MS = 20;
export const KEEP_SILENCE_CHUNKS = 10;
export const EDGE_SILENCE_CHUNKS = 2;
export const MIN_ANSWER_SAMPLES = 1600;
export const REPLY_QUIET_MS = 1800;
export const REPLY_MAX_WAIT_MS = 10000;
export const PROTOCOL_VERSION = 2;

export function gcsQuestionPaths(language: string, questionId: string) {
  const base = `questions/${language}/${questionId}`;
  return {
    wav: `${base}.wav`,
    json: `${base}.json`,
  };
}

export function languageNameForPrompt(code: string, label?: string): string {
  if (label) {
    return label.split("/")[0]?.trim() || code;
  }
  return code;
}

export function buildPlayAgentPrompt(languageName: string, englishQuestion: string): string {
  return `Translate to ${languageName}: ${englishQuestion}`;
}
