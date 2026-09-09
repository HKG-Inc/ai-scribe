import { HIKIGAI_BACKEND_URL_DEFAULT } from "@/lib/hikigai";
import { PATIENT_LANGUAGES, QUESTIONS } from "@/lib/conversation-mode";

export type StorageQuestionAsset = {
  locale: string;
  questionId: string;
  translatedText: string;
  audioUrl: string;
  expiresIn: number;
};

type StorageObject = {
  id: string;
  original_filename?: string;
  content_type?: string;
  metadata?: {
    locale?: string;
    question?: string;
  };
};

type StorageListResponse = {
  objects?: StorageObject[];
  total?: number;
};

type SignedUrlResponse = {
  object_id?: string;
  signed_url?: string;
  expires_in?: number;
};

const QUESTION_ID_SET = new Set(QUESTIONS.map((q) => q.id));
const LOCALE_SET = new Set(PATIENT_LANGUAGES.map((l) => l.value));

/** Short-lived cache of resolved object ids per locale_question. */
const objectIdCache = new Map<
  string,
  { audioId: string; jsonId: string; cachedAt: number }
>();
const OBJECT_ID_CACHE_TTL_MS = 30 * 60 * 1000;

/** Cache full assets (text + final playable URL) to skip platform round-trips. */
const assetCache = new Map<
  string,
  { asset: StorageQuestionAsset; cachedAt: number }
>();
const ASSET_CACHE_TTL_MS = 45 * 60 * 1000;

/**
 * Storage APIs must hit the API backend — not HIKIGAI_PLATFORM_URL (CloudFront).
 * CloudFront returns /storage/public/... links that 301/302 before S3 and add play delay.
 */
function getApiBackendUrl(): string {
  return (
    process.env.HIKIGAI_BASE_URL ||
    process.env.HIKIGAI_BACKEND_URL ||
    HIKIGAI_BACKEND_URL_DEFAULT
  );
}

function getApiKey(): string {
  const apiKey = process.env.HIKIGAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("Missing HIKIGAI_API_KEY");
  }
  return apiKey;
}

function getProjectId(): string {
  const projectId =
    process.env.QUESTIONNAIRE_STORAGE_PROJECT_ID ||
    process.env.HIKIGAI_PROJECT_ID ||
    "";
  if (!projectId) {
    throw new Error("Missing HIKIGAI_PROJECT_ID");
  }
  return projectId;
}

function getAppId(): string {
  const appId =
    process.env.QUESTIONNAIRE_STORAGE_APP_ID || process.env.HIKIGAI_APP_ID || "";
  if (!appId) {
    throw new Error("Missing HIKIGAI_APP_ID");
  }
  return appId;
}

function storageBasePath(): string {
  return `${getApiBackendUrl()}/api/v1/projects/${encodeURIComponent(getProjectId())}/apps/${encodeURIComponent(getAppId())}/storage`;
}

function authHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "X-Project-ID": getProjectId(),
  };
}

export function isValidStorageLocale(locale: string): boolean {
  return LOCALE_SET.has(locale as (typeof PATIENT_LANGUAGES)[number]["value"]);
}

export function isValidStorageQuestionId(questionId: string): boolean {
  return QUESTION_ID_SET.has(questionId);
}

function cacheKey(locale: string, questionId: string): string {
  return `${locale}_${questionId}`;
}

function extractQuestionText(payload: unknown): string {
  if (typeof payload === "string") {
    const trimmed = payload.replace(/^\uFEFF/, "").trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return extractQuestionText(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }

  const record = payload as Record<string, unknown>;
  const candidates = [
    record.text,
    record.translated_text,
    record.translation,
    record.question_text,
    record.question,
    record.content,
    record.output,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function isAudioObject(obj: StorageObject): boolean {
  const ct = (obj.content_type || "").toLowerCase();
  const name = (obj.original_filename || "").toLowerCase();
  return ct.includes("audio") || name.endsWith(".wav");
}

function isJsonObject(obj: StorageObject): boolean {
  const ct = (obj.content_type || "").toLowerCase();
  const name = (obj.original_filename || "").toLowerCase();
  return ct.includes("json") || name.endsWith(".json");
}

async function listStorageObjects(search: string): Promise<StorageObject[]> {
  const url = new URL(storageBasePath());
  url.searchParams.set("search", search);
  url.searchParams.set("limit", "20");
  url.searchParams.set("status", "active");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Storage list failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as StorageListResponse;
  return Array.isArray(data.objects) ? data.objects : [];
}

async function resolveObjectIds(
  locale: string,
  questionId: string
): Promise<{ audioId: string; jsonId: string }> {
  const key = cacheKey(locale, questionId);
  const cached = objectIdCache.get(key);
  if (cached && Date.now() - cached.cachedAt < OBJECT_ID_CACHE_TTL_MS) {
    return { audioId: cached.audioId, jsonId: cached.jsonId };
  }

  // Trailing "." avoids substring hits: search "hi-IN_q1" also matches q10–q19.
  const objects = await listStorageObjects(`${key}.`);
  const audioName = `${key}.wav`.toLowerCase();
  const jsonName = `${key}.json`.toLowerCase();

  const audio =
    objects.find(
      (obj) =>
        isAudioObject(obj) &&
        (obj.original_filename || "").toLowerCase() === audioName
    ) ||
    objects.find(
      (obj) =>
        isAudioObject(obj) &&
        obj.metadata?.question === questionId &&
        obj.metadata?.locale === locale
    );

  const json =
    objects.find(
      (obj) =>
        isJsonObject(obj) &&
        (obj.original_filename || "").toLowerCase() === jsonName
    ) ||
    objects.find(
      (obj) =>
        isJsonObject(obj) &&
        obj.metadata?.question === questionId &&
        obj.metadata?.locale === locale
    );

  if (!audio?.id || !json?.id) {
    throw new Error(
      `Storage assets not found for ${key} (audio=${Boolean(audio?.id)}, json=${Boolean(json?.id)})`
    );
  }

  objectIdCache.set(key, {
    audioId: audio.id,
    jsonId: json.id,
    cachedAt: Date.now(),
  });

  return { audioId: audio.id, jsonId: json.id };
}

async function getSignedUrl(
  objectId: string,
  ttlSeconds = 3600
): Promise<{ signedUrl: string; expiresIn: number }> {
  const url = new URL(`${storageBasePath()}/${encodeURIComponent(objectId)}/url`);
  url.searchParams.set("ttl", String(ttlSeconds));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Storage signed URL failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as SignedUrlResponse;
  if (!data.signed_url || typeof data.signed_url !== "string") {
    throw new Error("Storage signed URL missing in response");
  }

  return {
    signedUrl: data.signed_url,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : ttlSeconds,
  };
}

/**
 * Follow CDN/public wrappers (301/302) so the browser can hit S3 (or the final
 * host) directly instead of paying redirect latency on every play.
 * Already-direct S3 URLs skip the probe request.
 */
async function resolvePlayableUrl(startUrl: string): Promise<string> {
  try {
    const host = new URL(startUrl).hostname.toLowerCase();
    if (host.includes("s3.") || host.endsWith("amazonaws.com")) {
      return startUrl;
    }
  } catch {
    // fall through and try resolve
  }

  let current = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        redirect: "manual",
      });
    } catch {
      return current;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return current;
      }
      current = new URL(location, current).toString();
      continue;
    }

    return current;
  }
  return current;
}

async function downloadJsonText(objectId: string): Promise<string> {
  const response = await fetch(
    `${storageBasePath()}/${encodeURIComponent(objectId)}/download`,
    {
      method: "GET",
      headers: authHeaders(),
      redirect: "follow",
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Storage JSON download failed (${response.status}): ${error}`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("json")) {
    const data = await response.json();
    const text = extractQuestionText(data);
    if (!text) {
      throw new Error("Storage JSON did not contain question text");
    }
    return text;
  }

  const raw = await response.text();
  const text = extractQuestionText(raw);
  if (!text) {
    throw new Error("Storage JSON download was empty");
  }
  return text;
}

/**
 * Fetch pre-recorded translated text + direct playable WAV URL for a question/locale.
 * Throws when assets are missing or the platform storage call fails.
 */
export async function fetchStorageQuestion(
  locale: string,
  questionId: string
): Promise<StorageQuestionAsset> {
  if (!isValidStorageLocale(locale)) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  if (!isValidStorageQuestionId(questionId)) {
    throw new Error(`Unsupported question id: ${questionId}`);
  }

  const key = cacheKey(locale, questionId);
  const cachedAsset = assetCache.get(key);
  if (cachedAsset && Date.now() - cachedAsset.cachedAt < ASSET_CACHE_TTL_MS) {
    return cachedAsset.asset;
  }

  const load = async (allowObjectCache: boolean) => {
    if (!allowObjectCache) {
      objectIdCache.delete(key);
      assetCache.delete(key);
    }
    const { audioId, jsonId } = await resolveObjectIds(locale, questionId);
    // One signed URL (audio) + authenticated JSON download — fewer platform hops.
    const [translatedText, audioSigned] = await Promise.all([
      downloadJsonText(jsonId),
      getSignedUrl(audioId),
    ]);
    const audioUrl = await resolvePlayableUrl(audioSigned.signedUrl);

    const asset: StorageQuestionAsset = {
      locale,
      questionId,
      translatedText,
      audioUrl,
      expiresIn: audioSigned.expiresIn,
    };
    assetCache.set(key, { asset, cachedAt: Date.now() });
    return asset;
  };

  try {
    return await load(true);
  } catch (error) {
    // Stale cached object ids — clear and resolve once more from search.
    if (objectIdCache.has(key) || assetCache.has(key)) {
      return await load(false);
    }
    throw error;
  }
}
