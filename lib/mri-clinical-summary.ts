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
  describeMriAgentEnvelope,
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

export interface MriInputFile {
  filename: string;
  bytes: Buffer;
}

interface OcrPageResult {
  startPage: number;
  extractedText: string;
}

function ms(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** One JPEG + real page number per OCR invoke (reduces latency vs multi-image batches). */
async function invokeOcrPage(
  filename: string,
  pageNumber: number,
  jpeg: Buffer
): Promise<OcrPageResult> {
  const attachments: AgentAttachment[] = [
    {
      data_base64: jpeg.toString("base64"),
      mime_type: "image/jpeg",
    },
  ];

  const startedAt = performance.now();
  const raw = await hikigai.invokeAgent(
    MRI_OCR_AGENT,
    {
      filename,
      start_page: pageNumber,
      end_page: pageNumber,
    },
    MRI_AGENT_TIMEOUT_MS,
    attachments
  );
  console.log(
    `[mri-report-ocr-agent] ${filename} page ${pageNumber} took ${ms(startedAt)}ms`
  );

  const output = extractMriAgentOutput(raw);
  const extracted =
    typeof output.extracted_text === "string" ? output.extracted_text.trim() : "";

  if (!extracted) {
    throw new Error(
      `OCR agent returned no text for ${filename} page ${pageNumber}`
    );
  }

  return { startPage: pageNumber, extractedText: extracted };
}

/**
 * Per-page OCR invokes in parallel (one JPEG each), then stitch in page order.
 * Keeps === PAGE N === headers from the agent; does not rename them to REPORT.
 * JPEGs are rendered sequentially (MuPDF doc is not concurrency-safe); OCR calls run in parallel.
 */
async function ocrScannedDoc(
  filename: string,
  doc: ReturnType<typeof openPdfDocument>
): Promise<string> {
  const pageCount = doc.countPages();
  if (pageCount === 0) {
    throw new Error(`PDF has no pages: ${filename}`);
  }

  const renderStartedAt = performance.now();
  const pages: Array<{ pageNumber: number; jpeg: Buffer }> = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const [jpeg] = renderPageRangeJpeg(doc, pageNumber - 1, pageNumber);
    pages.push({ pageNumber, jpeg });
  }
  console.log(
    `[mri-ocr] ${filename} rendered ${pageCount} JPEG(s) in ${ms(renderStartedAt)}ms`
  );

  const ocrStartedAt = performance.now();
  const pageResults = await Promise.all(
    pages.map(({ pageNumber, jpeg }) =>
      invokeOcrPage(filename, pageNumber, jpeg)
    )
  );
  console.log(
    `[mri-ocr] ${filename} parallel OCR wall time ${ms(ocrStartedAt)}ms (${pageCount} page invokes)`
  );

  return pageResults
    .sort((a, b) => a.startPage - b.startPage)
    .map((page) => page.extractedText.trim())
    .join("\n\n")
    .trim();
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
  const pipelineStartedAt = performance.now();

  // Exchange API key for session token while MuPDF work runs (hidden latency).
  const authReady = hikigai.ensureAuthToken(false, MRI_AGENT_TIMEOUT_MS);

  const extractStartedAt = performance.now();
  const extractedResults = await Promise.all(
    files.map(async (file) => {
      const text = await extractFileText(file);
      if (!text) return null;
      return { filename: file.filename, text };
    })
  );
  console.log(
    `[mri-pipeline] text extraction (incl. OCR) took ${ms(extractStartedAt)}ms`
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

  const summaryStartedAt = performance.now();
  const raw = await hikigai.invokeAgent(
    MRI_SUMMARY_AGENT,
    { message },
    MRI_AGENT_TIMEOUT_MS
  );
  console.log(
    `[mri-clinical-summary-agent] took ${ms(summaryStartedAt)}ms`,
    describeMriAgentEnvelope(raw)
  );

  const data = parseSummaryOutput(raw);

  if (!data.studies.length) {
    console.warn(
      "[mri-clinical-summary-agent] no studies parsed:",
      describeMriAgentEnvelope(raw)
    );
    throw new Error(
      `Summary agent returned no studies (${describeMriAgentEnvelope(raw)})`
    );
  }

  console.log(
    `[mri-pipeline] total wall time ${ms(pipelineStartedAt)}ms`
  );

  return data;
}
