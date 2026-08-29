import { hikigai, type AgentAttachment } from "@/lib/hikigai";
import {
  decodeTextFile,
  extractPdfText,
  isPdfBytes,
  renderAllPagesJpeg,
} from "@/lib/mri-pdf";

export const MRI_AGENT_TIMEOUT_MS = 180_000;
export const MRI_OCR_BATCH_SIZE = 5;
export const MRI_OCR_PARALLEL_BATCHES = 2;
export const MRI_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export const MRI_OCR_AGENT = "mri-report-ocr-agent";
export const MRI_SUMMARY_AGENT = "mri-clinical-summary-agent";

export interface MriInputFile {
  filename: string;
  bytes: Buffer;
}

export interface MriFinding {
  pathology: string;
  details: string;
}

export interface MriStudy {
  filename: string;
  region: string;
  human_label: string;
  date: string;
  contrast: string;
  doctor_name: string;
  findings_text: string;
  impressions_text: string;
  /** Kept exactly as returned by the summary agent (objects and/or strings). */
  findings: Array<MriFinding | string>;
}

export interface MriClinicalSummaryData {
  patient_label: string;
  studies: MriStudy[];
}

interface OcrBatch {
  startPage: number;
  endPage: number;
  jpegs: Buffer[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Prefer response.output (structured schema). Fall back to parsing
 * response.content when output is missing or a JSON string.
 */
function parseAgentPayload(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};

  const tryParse = (value: unknown): Record<string, unknown> | null => {
    if (!value) return null;
    if (typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return asRecord(parsed);
      } catch {
        return null;
      }
    }
    return null;
  };

  return (
    tryParse(root.output) ||
    tryParse(root.content) ||
    tryParse(root.result) ||
    tryParse(root.data) ||
    root
  );
}

function chunkOcrBatches(jpegs: Buffer[]): OcrBatch[] {
  const batches: OcrBatch[] = [];
  for (let i = 0; i < jpegs.length; i += MRI_OCR_BATCH_SIZE) {
    const slice = jpegs.slice(i, i + MRI_OCR_BATCH_SIZE);
    batches.push({
      startPage: i + 1,
      endPage: i + slice.length,
      jpegs: slice,
    });
  }
  return batches;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await fn(items[current], current);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function invokeOcrBatch(
  filename: string,
  batch: OcrBatch
): Promise<string> {
  // JPEG attachments only — never send PDF bytes to the OCR agent.
  const attachments: AgentAttachment[] = batch.jpegs.map((jpeg) => ({
    data_base64: jpeg.toString("base64"),
    mime_type: "image/jpeg",
  }));

  const raw = await hikigai.invokeAgent(
    MRI_OCR_AGENT,
    {
      filename,
      start_page: batch.startPage,
      end_page: batch.endPage,
    },
    MRI_AGENT_TIMEOUT_MS,
    attachments
  );

  const output = parseAgentPayload(raw);
  const extracted =
    typeof output.extracted_text === "string" ? output.extracted_text.trim() : "";

  if (!extracted) {
    throw new Error(
      `OCR agent returned no text for ${filename} pages ${batch.startPage}-${batch.endPage}`
    );
  }

  return extracted;
}

async function ocrScannedPdf(filename: string, bytes: Buffer): Promise<string> {
  const jpegs = renderAllPagesJpeg(bytes);
  if (jpegs.length === 0) {
    throw new Error(`PDF has no pages: ${filename}`);
  }

  const batches = chunkOcrBatches(jpegs);
  const batchTexts = await runWithConcurrency(
    batches,
    MRI_OCR_PARALLEL_BATCHES,
    (batch) => invokeOcrBatch(filename, batch)
  );

  return batchTexts.join("\n\n").trim();
}

/**
 * Step 2–3: digital MuPDF text, or scanned → JPEG → OCR agent.
 * PDF bytes never leave this process toward either agent.
 */
export async function extractFileText(file: MriInputFile): Promise<string> {
  if (isPdfBytes(file.bytes)) {
    const pdfText = extractPdfText(file.bytes);
    if (pdfText) {
      return pdfText;
    }
    return ocrScannedPdf(file.filename, file.bytes);
  }

  return decodeTextFile(file.bytes).trim();
}

/** Step 4 — stitch reports for the summary agent. */
export function stitchReportTexts(
  files: Array<{ filename: string; text: string }>
): string {
  return files
    .map(
      (file, index) =>
        `=== REPORT ${index + 1} ===\nFILENAME: ${file.filename}\n${file.text}`
    )
    .join("\n\n")
    .trim();
}

/**
 * Step 5 wrapper — must match this string exactly.
 * Summary agent receives text only (no attachments / no PDF).
 */
export function buildSummaryMessage(combinedText: string): string {
  return (
    "You are given one or more MRI radiology reports for a single patient.\n\n" +
    "Use the system instructions to create a pathology-only clinical summary.\n\n" +
    `FULL MRI REPORTS TEXT:\n${combinedText}`
  );
}

function normalizeFindings(raw: unknown): Array<MriFinding | string> {
  // Keep agent findings exactly as returned — no reformatting.
  if (!Array.isArray(raw)) return [];
  return raw as Array<MriFinding | string>;
}

function normalizeStudy(raw: Record<string, unknown>): MriStudy {
  return {
    filename: typeof raw.filename === "string" ? raw.filename : "",
    region: typeof raw.region === "string" ? raw.region : "",
    human_label: typeof raw.human_label === "string" ? raw.human_label : "",
    date: typeof raw.date === "string" ? raw.date : "",
    contrast: typeof raw.contrast === "string" ? raw.contrast : "",
    doctor_name: typeof raw.doctor_name === "string" ? raw.doctor_name : "",
    findings_text:
      typeof raw.findings_text === "string" ? raw.findings_text : "",
    impressions_text:
      typeof raw.impressions_text === "string" ? raw.impressions_text : "",
    findings: normalizeFindings(raw.findings),
  };
}

export function parseSummaryOutput(payload: unknown): MriClinicalSummaryData {
  const output = parseAgentPayload(payload);
  const patient_label =
    typeof output.patient_label === "string" && output.patient_label.trim()
      ? output.patient_label.trim()
      : "PATIENT 1";

  const studiesRaw = Array.isArray(output.studies) ? output.studies : [];
  const studies = studiesRaw
    .map((item) =>
      item && typeof item === "object"
        ? normalizeStudy(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is MriStudy => item !== null);

  return { patient_label, studies };
}

/**
 * Full pipeline:
 * 1. extract text per file (MuPDF or OCR)
 * 2. stitch === REPORT n === / FILENAME:
 * 3. send that combined PDF text to mri-clinical-summary-agent
 * 4. return { patient_label, studies }
 */
export async function generateMriClinicalSummary(
  files: MriInputFile[]
): Promise<MriClinicalSummaryData> {
  const extracted: Array<{ filename: string; text: string }> = [];

  for (const file of files) {
    const text = await extractFileText(file);
    if (text) {
      extracted.push({ filename: file.filename, text });
    }
  }

  const combinedText = stitchReportTexts(extracted);
  if (!combinedText) {
    throw new Error("No extractable text from uploaded MRI files");
  }

  // Summary agent gets text only — stitched report text inside the fixed wrapper.
  const message = buildSummaryMessage(combinedText);

  console.log("[mri-clinical-summary] invoking summary agent", {
    files: extracted.map((f) => f.filename),
    combinedTextChars: combinedText.length,
    messageChars: message.length,
  });

  const raw = await hikigai.invokeAgent(
    MRI_SUMMARY_AGENT,
    { message },
    MRI_AGENT_TIMEOUT_MS
  );

  console.log(
    "[mri-clinical-summary] summary agent raw response:",
    JSON.stringify(raw, null, 2)
  );

  const data = parseSummaryOutput(raw);
  console.log(
    "[mri-clinical-summary] summary agent parsed data:",
    JSON.stringify(data, null, 2)
  );

  if (!data.studies.length) {
    throw new Error("Summary agent returned no studies");
  }

  return data;
}
