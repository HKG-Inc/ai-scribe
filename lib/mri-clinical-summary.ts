import { extractAgentOutput } from "@/lib/questionnaire-visit-notes";
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
  findings: MriFinding[];
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
  const attachments: AgentAttachment[] = batch.jpegs.map((jpeg) => ({
    data_base64: jpeg.toString("base64"),
    mime_type: "image/jpeg",
  }));

  const raw = await hikigai.invokeAgent(
    "mri-report-ocr-agent",
    {
      filename,
      start_page: batch.startPage,
      end_page: batch.endPage,
    },
    MRI_AGENT_TIMEOUT_MS,
    attachments
  );

  const output = extractAgentOutput(raw);
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

export function buildSummaryMessage(combinedText: string): string {
  return (
    "You are given one or more MRI radiology reports for a single patient.\n\n" +
    "Use the system instructions to create a pathology-only clinical summary.\n\n" +
    `FULL MRI REPORTS TEXT:\n${combinedText}`
  );
}

function normalizeStudy(raw: Record<string, unknown>): MriStudy {
  const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: MriFinding[] = findingsRaw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const pathology =
        typeof row.pathology === "string" ? row.pathology.trim() : "";
      const details = typeof row.details === "string" ? row.details.trim() : "";
      if (!pathology && !details) return null;
      return { pathology, details };
    })
    .filter((item): item is MriFinding => item !== null);

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
    findings,
  };
}

export function parseSummaryOutput(payload: unknown): MriClinicalSummaryData {
  const output = extractAgentOutput(payload);
  const patient_label =
    typeof output.patient_label === "string" ? output.patient_label : "PATIENT 1";

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

  const message = buildSummaryMessage(combinedText);
  const raw = await hikigai.invokeAgent(
    "mri-clinical-summary-agent",
    { message },
    MRI_AGENT_TIMEOUT_MS
  );

  return parseSummaryOutput(raw);
}
