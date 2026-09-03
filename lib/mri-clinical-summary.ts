import { hikigai, type AgentAttachment } from "@/lib/hikigai";
import {
  decodeTextFile,
  extractTextFromDoc,
  isPdfBytes,
  isScannedPdf,
  openPdfDocument,
  renderPageRangeJpeg,
} from "@/lib/mri-pdf";
import {
  buildSummaryMessage,
  extractMriAgentOutput,
  MRI_OCR_AGENT,
  MRI_SUMMARY_AGENT,
  parseSummaryOutput,
  stitchReportTexts,
  type MriClinicalSummaryData,
  type MriFinding,
  type MriStudy,
} from "@/lib/mri-clinical-summary-format";

export {
  buildSummaryMessage,
  extractMriAgentOutput,
  MRI_MAX_TOTAL_BYTES,
  MRI_OCR_AGENT,
  MRI_SUMMARY_AGENT,
  parseSummaryOutput,
  stitchReportTexts,
  type MriClinicalSummaryData,
  type MriFinding,
  type MriStudy,
} from "@/lib/mri-clinical-summary-format";

export const MRI_AGENT_TIMEOUT_MS = 180_000;
export const MRI_OCR_BATCH_SIZE = 5;
export const MRI_OCR_PARALLEL_BATCHES = 2;

export interface MriInputFile {
  filename: string;
  bytes: Buffer;
}

interface OcrBatchSpec {
  startPage: number;
  endPage: number;
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
  batch: OcrBatchSpec,
  jpegs: Buffer[]
): Promise<string> {
  const attachments: AgentAttachment[] = jpegs.map((jpeg) => ({
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

  const output = extractMriAgentOutput(raw);
  const extracted =
    typeof output.extracted_text === "string" ? output.extracted_text.trim() : "";

  if (!extracted) {
    throw new Error(
      `OCR agent returned no text for ${filename} pages ${batch.startPage}-${batch.endPage}`
    );
  }

  return extracted;
}

function buildOcrBatchSpecs(pageCount: number): OcrBatchSpec[] {
  const batches: OcrBatchSpec[] = [];
  for (let i = 0; i < pageCount; i += MRI_OCR_BATCH_SIZE) {
    const startPage = i + 1;
    const endPage = Math.min(i + MRI_OCR_BATCH_SIZE, pageCount);
    batches.push({ startPage, endPage });
  }
  return batches;
}

/**
 * Render + OCR in batch-sized chunks so JPEG work overlaps agent calls
 * instead of rendering every page before the first OCR invoke.
 */
async function ocrScannedDoc(
  filename: string,
  doc: ReturnType<typeof openPdfDocument>
): Promise<string> {
  const pageCount = doc.countPages();
  if (pageCount === 0) {
    throw new Error(`PDF has no pages: ${filename}`);
  }

  const batchSpecs = buildOcrBatchSpecs(pageCount);
  const batchTexts = await runWithConcurrency(
    batchSpecs,
    MRI_OCR_PARALLEL_BATCHES,
    async (spec) => {
      const jpegs = renderPageRangeJpeg(doc, spec.startPage - 1, spec.endPage);
      return invokeOcrBatch(filename, spec, jpegs);
    }
  );

  return batchTexts.join("\n\n").trim();
}

/**
 * Step 2–3: digital MuPDF text, or scanned → JPEG → OCR agent.
 * Opens each PDF once (no scan-check reopen for OCR path).
 */
export async function extractFileText(file: MriInputFile): Promise<string> {
  if (isPdfBytes(file.bytes)) {
    const doc = openPdfDocument(file.bytes);
    try {
      if (isScannedPdf(doc)) {
        return ocrScannedDoc(file.filename, doc);
      }
      return extractTextFromDoc(doc);
    } finally {
      doc.destroy();
    }
  }

  return decodeTextFile(file.bytes).trim();
}

/**
 * Full pipeline:
 * 1. extract text per file (MuPDF or OCR) — files in parallel
 * 2. stitch === REPORT n === / FILENAME:
 * 3. send that combined PDF text to mri-clinical-summary-agent
 * 4. return { patient_label, studies }
 */
export async function generateMriClinicalSummary(
  files: MriInputFile[]
): Promise<MriClinicalSummaryData> {
  // Exchange API key for session token while MuPDF work runs (hidden latency).
  const authReady = hikigai.ensureAuthToken(false, MRI_AGENT_TIMEOUT_MS);

  const extractedResults = await Promise.all(
    files.map(async (file) => {
      const text = await extractFileText(file);
      if (!text) return null;
      return { filename: file.filename, text };
    })
  );

  await authReady;

  const extracted = extractedResults.filter(
    (item): item is { filename: string; text: string } => item !== null
  );

  const combinedText = stitchReportTexts(extracted);
  if (!combinedText) {
    throw new Error("No extractable text from uploaded MRI files");
  }

  const message = buildSummaryMessage(combinedText);

  const raw = await hikigai.invokeAgent(
    MRI_SUMMARY_AGENT,
    { message },
    MRI_AGENT_TIMEOUT_MS
  );

  const data = parseSummaryOutput(raw);

  if (!data.studies.length) {
    const root =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    const topKeys = root ? Object.keys(root).join(",") : typeof raw;
    const responseKeys =
      root?.response && typeof root.response === "object"
        ? Object.keys(root.response as object).join(",")
        : "";
    throw new Error(
      `Summary agent returned no studies (keys=${topKeys}` +
        (responseKeys ? ` response.keys=${responseKeys}` : "") +
        ")"
    );
  }

  return data;
}
