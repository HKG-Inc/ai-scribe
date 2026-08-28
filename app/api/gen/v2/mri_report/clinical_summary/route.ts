import { NextResponse } from "next/server";
import {
  generateMriClinicalSummary,
  MRI_MAX_TOTAL_BYTES,
  type MriInputFile,
} from "@/lib/mri-clinical-summary";

export const runtime = "nodejs";
export const maxDuration = 300;

interface JsonMriFile {
  filename?: string;
  content_base64?: string;
}

function decodeBase64(value: string): Buffer | null {
  try {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return Buffer.from(trimmed, "base64");
  } catch {
    return null;
  }
}

async function parseMultipartFiles(
  request: Request
): Promise<MriInputFile[] | NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { status: "error", message: "Invalid multipart form data" },
      { status: 400 }
    );
  }

  const entries = formData.getAll("mri_files");
  const files: MriInputFile[] = [];

  for (const entry of entries) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    const bytes = Buffer.from(await entry.arrayBuffer());
    if (!bytes.length) continue;
    files.push({ filename: entry.name || "upload.pdf", bytes });
  }

  return files;
}

async function parseJsonFiles(
  request: Request
): Promise<MriInputFile[] | NextResponse> {
  let body: { mri_files?: JsonMriFile[] };
  try {
    body = (await request.json()) as { mri_files?: JsonMriFile[] };
  } catch {
    return NextResponse.json(
      { status: "error", message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.mri_files)) {
    return NextResponse.json(
      { status: "error", message: "mri_files array is required" },
      { status: 400 }
    );
  }

  const files: MriInputFile[] = [];

  for (const item of body.mri_files) {
    const filename =
      typeof item.filename === "string" && item.filename.trim()
        ? item.filename.trim()
        : "upload.pdf";
    const contentBase64 =
      typeof item.content_base64 === "string" ? item.content_base64 : "";
    const bytes = decodeBase64(contentBase64);
    if (!bytes?.length) continue;
    files.push({ filename, bytes });
  }

  return files;
}

function missingFilesResponse(): NextResponse {
  return NextResponse.json(
    {
      status: "error",
      message: "No valid MRI files provided",
    },
    { status: 400 }
  );
}

function payloadTooLargeResponse(): NextResponse {
  return NextResponse.json(
    {
      status: "error",
      message: "Total upload size exceeds 16 MB limit",
    },
    { status: 400 }
  );
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    if (authHeader && !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { status: "error", message: "Invalid Authorization header" },
        { status: 401 }
      );
    }

    const contentType = request.headers.get("content-type") || "";
    const parsed = contentType.includes("multipart/form-data")
      ? await parseMultipartFiles(request)
      : await parseJsonFiles(request);

    if (parsed instanceof NextResponse) {
      return parsed;
    }

    if (parsed.length === 0) {
      return missingFilesResponse();
    }

    const totalBytes = parsed.reduce((sum, file) => sum + file.bytes.length, 0);
    if (totalBytes > MRI_MAX_TOTAL_BYTES) {
      return payloadTooLargeResponse();
    }

    const data = await generateMriClinicalSummary(parsed);

    return NextResponse.json({
      status: "success",
      message: "MRI clinical summary processed successfully.",
      data,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to process MRI clinical summary";

    const status =
      message.includes("No extractable text") ||
      message.includes("No valid MRI files")
        ? 400
        : 500;

    return NextResponse.json({ status: "error", message }, { status });
  }
}
