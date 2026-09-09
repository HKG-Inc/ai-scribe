import { hikigai, type AgentAttachment } from "@/lib/hikigai";
import { logger } from "@/lib/logger";
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
  logger.info("mri-report-ocr-agent", "page OCR complete", {
    filename,
    pageNumber,
    durationMs: ms(startedAt),
  });

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
  logger.info("mri-ocr", "JPEG render complete", {
    filename,
    pageCount,
    durationMs: ms(renderStartedAt),
  });

  const ocrStartedAt = performance.now();
  const pageResults = await Promise.all(
    pages.map(({ pageNumber, jpeg }) =>
      invokeOcrPage(filename, pageNumber, jpeg)
    )
  );
  logger.info("mri-ocr", "parallel OCR complete", {
    filename,
    pageCount,
    durationMs: ms(ocrStartedAt),
  });

  return pageResults
    .sort((a, b) => a.startPage - b.startPage)
    .map((page) => page.extractedText.trim())
    .join("\n\n")
    .trim();
}

/**
 * Step 2–3: digital MuPDF text, or scanned → JPEG → OCR agent.
 * Opens each PDF once (no scan-check reopen for OCR path).
 * If a "digital" PDF yields no usable text, fall back to OCR so the file is
 * not silently dropped later in the pipeline.
 */
export async function extractFileText(file: MriInputFile): Promise<string> {
  if (isPdfBytes(file.bytes)) {
    const doc = openPdfDocument(file.bytes);
    try {
      if (doc.countPages() === 0) {
        throw new Error(`PDF has no pages: ${file.filename}`);
      }
      if (isScannedPdf(doc)) {
        return ocrScannedDoc(file.filename, doc);
      }
      const digital = extractTextFromDoc(doc).trim();
      if (digital) return digital;

      logger.warn("mri-pipeline", "digital extract empty; falling back to OCR", {
        filename: file.filename,
      });
      return ocrScannedDoc(file.filename, doc);
    } finally {
      doc.destroy();
    }
  }

  return decodeTextFile(file.bytes).trim();
}

/**
 * Summarize one extracted MRI report. Filename is stamped on every study so
 * multi-file uploads stay attributable when the agent omits filename.
 */
async function summarizeExtractedReport(file: {
  filename: string;
  text: string;
}): Promise<MriClinicalSummaryData> {
  const reportText = stitchReportTexts([file]);
  const message = buildSummaryMessage(reportText);

  const summaryStartedAt = performance.now();
  const raw = await hikigai.invokeAgent(
    MRI_SUMMARY_AGENT,
    { message },
    MRI_AGENT_TIMEOUT_MS
  );
  logger.info("mri-clinical-summary-agent", "summary complete", {
    filename: file.filename,
    durationMs: ms(summaryStartedAt),
    envelope: describeMriAgentEnvelope(raw),
    rawResponse: raw,
  });

  const data = parseSummaryOutput(raw);
  if (!data.studies.length) {
    logger.warn("mri-clinical-summary-agent", "no studies parsed", {
      filename: file.filename,
      envelope: describeMriAgentEnvelope(raw),
      rawResponse: raw,
    });
    throw new Error(
      `Summary agent returned no studies for ${file.filename} (${describeMriAgentEnvelope(raw)})`
    );
  }

  return {
    patient_label: data.patient_label,
    studies: data.studies.map((study) => ({
      ...study,
      // Always attribute to the uploaded file (ignore agent-supplied names).
      filename: file.filename,
    })),
  };
}

/**
 * Full pipeline:
 * 1. extract text per file (MuPDF or OCR) — files in parallel
 * 2. summarize each file independently (avoids the agent dropping regions
 *    when multiple reports are stitched into one prompt)
 * 3. merge { patient_label, studies } across files
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
      return { filename: file.filename, text: text.trim() };
    })
  );
  logger.info("mri-pipeline", "text extraction complete", {
    durationMs: ms(extractStartedAt),
  });

  await authReady;

  const failedExtractions = extractedResults.filter((item) => !item.text);
  if (failedExtractions.length) {
    const names = failedExtractions.map((item) => item.filename).join(", ");
    throw new Error(
      failedExtractions.length === files.length
        ? "No extractable text from uploaded MRI files"
        : `Could not extract text from ${failedExtractions.length} of ${files.length} MRI file(s): ${names}`
    );
  }

  const extracted = extractedResults as Array<{ filename: string; text: string }>;

  const summaryStartedAt = performance.now();
  const summaries = await Promise.all(
    extracted.map((file) => summarizeExtractedReport(file))
  );
  logger.info("mri-pipeline", "summary agent calls complete", {
    summaryCount: summaries.length,
    durationMs: ms(summaryStartedAt),
  });

  const studies = summaries.flatMap((summary) => summary.studies);
  if (!studies.length) {
    throw new Error("Summary agent returned no studies");
  }

  // Every uploaded file must produce at least one study — otherwise the UI
  // shows N files but only N-1 responses (common with multi-file uploads).
  const studyFilenames = new Set(
    studies.map((study) => study.filename?.trim()).filter(Boolean)
  );
  const missingStudyFiles = files
    .map((file) => file.filename)
    .filter((filename) => !studyFilenames.has(filename));
  if (missingStudyFiles.length) {
    throw new Error(
      `MRI summary missing for ${missingStudyFiles.length} file(s): ${missingStudyFiles.join(", ")}`
    );
  }

  const patient_label =
    summaries.find((summary) => summary.patient_label.trim())?.patient_label ||
    "PATIENT 1";

  logger.info("mri-pipeline", "pipeline complete", {
    durationMs: ms(pipelineStartedAt),
    studyCount: studies.length,
  });

  return { patient_label, studies };
}
