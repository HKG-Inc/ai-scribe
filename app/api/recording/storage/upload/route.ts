import { NextResponse } from "next/server";
import { buildVisitRecordingFilename } from "@/lib/audio/pcm-wav";
import { errorFields, logger } from "@/lib/logger";
import { uploadVisitRecordingWav } from "@/lib/recording-storage";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // platform limit

/**
 * POST /api/recording/storage/upload
 *
 * Accepts multipart form field `file` (WAV) and uploads to Hikigai app object
 * storage under `{YYYYMMDD}_{HHMMSS}_{8-char-uuid}.wav`.
 */
export async function POST(request: Request) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart form data" }, { status: 400 });
    }

    const entry = formData.get("file");
    if (!(entry instanceof File) || entry.size === 0) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    if (entry.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Recording exceeds 100 MB storage limit" },
        { status: 400 }
      );
    }

    const visitId =
      typeof formData.get("visit_id") === "string"
        ? String(formData.get("visit_id")).trim()
        : "";
    const sessionId =
      typeof formData.get("session_id") === "string"
        ? String(formData.get("session_id")).trim()
        : "";

    const filename = buildVisitRecordingFilename();
    const bytes = new Uint8Array(await entry.arrayBuffer());
    const blob = new Blob([bytes], { type: "audio/wav" });

    const metadata: Record<string, string> = {
      description: "Visit recording audio",
      generated_by: "ai-scribe-recording",
      content_kind: "visit_recording",
    };
    if (visitId) metadata.visit_id = visitId;
    if (sessionId) metadata.session_id = sessionId;

    const uploaded = await uploadVisitRecordingWav({
      file: blob,
      filename,
      metadata,
    });

    logger.info("recording/storage/upload", "visit wav uploaded", {
      objectId: uploaded.object_id,
      filename: uploaded.original_filename,
      sizeBytes: uploaded.size_bytes ?? bytes.byteLength,
      visitId: visitId || undefined,
    });

    return NextResponse.json(
      {
        object_id: uploaded.object_id,
        object_key: uploaded.object_key,
        original_filename: uploaded.original_filename,
        content_type: uploaded.content_type || "audio/wav",
        size_bytes: uploaded.size_bytes ?? bytes.byteLength,
        signed_url: uploaded.signed_url,
        created_at: uploaded.created_at,
      },
      { status: 201 }
    );
  } catch (error) {
    logger.error("recording/storage/upload", "upload failed", errorFields(error));
    const message =
      error instanceof Error ? error.message : "Failed to upload visit recording";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
