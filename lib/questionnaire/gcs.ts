import { Storage } from "@google-cloud/storage";
import {
  CANNED_QUESTION_LANGUAGES,
  GCS_QUESTIONNAIRE_BUCKET,
  GCS_SIGNED_URL_TTL_MS,
  gcsQuestionPaths,
} from "@/lib/questionnaire/constants";

export interface CannedQuestionPayload {
  available: true;
  text: string;
  original_text: string;
  wav_url: string;
}

export interface CannedQuestionMissing {
  available: false;
}

export type CannedQuestionResult = CannedQuestionPayload | CannedQuestionMissing;

let storageClient: Storage | null = null;

function getStorage(): Storage | null {
  if (storageClient) return storageClient;
  try {
    storageClient = new Storage();
    return storageClient;
  } catch {
    return null;
  }
}

export function isCannedLanguage(language: string): boolean {
  return CANNED_QUESTION_LANGUAGES.has(language);
}

export async function fetchCannedQuestion(
  language: string,
  questionId: string
): Promise<CannedQuestionResult> {
  if (!isCannedLanguage(language)) {
    return { available: false };
  }

  const storage = getStorage();
  if (!storage) {
    return { available: false };
  }

  const bucket = storage.bucket(GCS_QUESTIONNAIRE_BUCKET);
  const paths = gcsQuestionPaths(language, questionId);
  const wavFile = bucket.file(paths.wav);
  const jsonFile = bucket.file(paths.json);

  try {
    const [wavExists, jsonExists] = await Promise.all([
      wavFile.exists().then(([exists]) => exists),
      jsonFile.exists().then(([exists]) => exists),
    ]);

    if (!wavExists || !jsonExists) {
      return { available: false };
    }

    const expires = Date.now() + GCS_SIGNED_URL_TTL_MS;
    const [wavUrl] = await wavFile.getSignedUrl({
      version: "v4",
      action: "read",
      expires,
    });

    const [jsonBuffer] = await jsonFile.download();
    const parsed = JSON.parse(jsonBuffer.toString("utf8")) as {
      text?: string;
      original_text?: string;
    };

    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const original_text =
      typeof parsed.original_text === "string" ? parsed.original_text.trim() : "";

    if (!text || !wavUrl) {
      return { available: false };
    }

    return {
      available: true,
      text,
      original_text,
      wav_url: wavUrl,
    };
  } catch {
    return { available: false };
  }
}
