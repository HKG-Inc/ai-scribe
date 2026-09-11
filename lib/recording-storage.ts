import { HIKIGAI_BACKEND_URL_DEFAULT } from "@/lib/hikigai";

export type StorageUploadResult = {
  object_id: string;
  object_key?: string;
  original_filename: string;
  content_type?: string;
  size_bytes?: number;
  signed_url?: string;
  created_at?: string;
};

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
  const projectId = process.env.HIKIGAI_PROJECT_ID || "";
  if (!projectId) {
    throw new Error("Missing HIKIGAI_PROJECT_ID");
  }
  return projectId;
}

function getAppId(): string {
  const appId = process.env.HIKIGAI_APP_ID || "";
  if (!appId) {
    throw new Error("Missing HIKIGAI_APP_ID");
  }
  return appId;
}

function storageUploadUrl(): string {
  return `${getApiBackendUrl()}/api/v1/projects/${encodeURIComponent(getProjectId())}/apps/${encodeURIComponent(getAppId())}/storage/upload`;
}

/**
 * Upload a visit recording WAV to platform app object storage.
 * Uses HIKIGAI_APP_ID so files land under this app's Documents tab.
 */
export async function uploadVisitRecordingWav(params: {
  file: Blob | File | Buffer;
  filename: string;
  metadata?: Record<string, string>;
}): Promise<StorageUploadResult> {
  const projectId = getProjectId();
  const form = new FormData();

  const blob =
    params.file instanceof Blob
      ? params.file
      : new Blob([new Uint8Array(params.file)], { type: "audio/wav" });

  form.append("file", blob, params.filename);
  form.append("filename", params.filename);

  if (params.metadata && Object.keys(params.metadata).length > 0) {
    form.append("metadata", JSON.stringify(params.metadata));
  }

  const response = await fetch(storageUploadUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "X-Project-ID": projectId,
    },
    body: form,
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Storage upload failed (${response.status}): ${error}`);
  }

  const data = (await response.json()) as StorageUploadResult;
  if (!data.object_id) {
    throw new Error("Storage upload response missing object_id");
  }

  return {
    ...data,
    original_filename: data.original_filename || params.filename,
  };
}
