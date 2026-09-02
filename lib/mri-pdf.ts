import mupdf, { Document, type Page } from "mupdf";

export const VISION_RENDER_ZOOM = 2.0;
export const VISION_MAX_LONG_SIDE_PX = 2560;
export const VISION_JPEG_QUALITY = 95;

const SCANNED_PAGE_TEXT_THRESHOLD = 50;
const SCANNED_SAMPLE_PAGES = 3;
const SHORT_PAGE_TEXT_THRESHOLD = 100;

function pagePlainText(page: Page): string {
  return page.toStructuredText().asText();
}

function extractSpansFromJson(jsonStr: string): string {
  try {
    const parsed = JSON.parse(jsonStr) as unknown;
    const parts: string[] = [];

    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (typeof obj.text === "string" && obj.text.trim()) {
        parts.push(obj.text);
      }
      for (const value of Object.values(obj)) {
        walk(value);
      }
    };

    walk(parsed);
    return parts.join("");
  } catch {
    return "";
  }
}

/**
 * Default: toStructuredText().asText() (PyMuPDF page.get_text()).
 * If ≤ 100 chars, retry get_text("text") then get_text("dict") equivalents
 * and use whichever yields more text.
 */
function pageTextWithFallback(page: Page): string {
  let best = pagePlainText(page).trim();
  if (best.length > SHORT_PAGE_TEXT_THRESHOLD) {
    return best;
  }

  const textMode = page.toStructuredText("preserve-whitespace").asText().trim();
  if (textMode.length > best.length) {
    best = textMode;
  }
  if (best.length > SHORT_PAGE_TEXT_THRESHOLD) {
    return best;
  }

  const spanText = extractSpansFromJson(
    page.toStructuredText("preserve-spans").asJSON()
  ).trim();

  if (spanText.length > best.length) {
    return spanText;
  }

  return best;
}

export function isPdfBytes(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF";
}

export function decodeTextFile(bytes: Buffer): string {
  const utf8 = bytes.toString("utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }

  try {
    return new TextDecoder("windows-1252").decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

function openPdfDocument(bytes: Buffer): Document {
  return Document.openDocument(bytes, "application/pdf");
}

export { openPdfDocument };

/**
 * Sample first min(3, pageCount) pages.
 * Page is scanned if plain text length < 50.
 * If ≥ 2 sample pages are scanned → scanned document.
 * For a 1-page PDF, that single page being scanned also counts
 * (otherwise OCR would never run on single-page scans).
 */
export function isScannedPdf(doc: Document): boolean {
  const pageCount = doc.countPages();
  const sample = Math.min(SCANNED_SAMPLE_PAGES, pageCount);
  if (sample === 0) return false;

  let scanned = 0;
  for (let i = 0; i < sample; i++) {
    const page = doc.loadPage(i);
    try {
      const text = pagePlainText(page).trim();
      if (text.length < SCANNED_PAGE_TEXT_THRESHOLD) {
        scanned += 1;
      }
    } finally {
      page.destroy();
    }
  }

  const needed = Math.min(2, sample);
  return scanned >= needed;
}

/**
 * MuPDF text extract from an already-open document.
 */
export function extractTextFromDoc(doc: Document): string {
  const chunks: string[] = [];
  const pageCount = doc.countPages();

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    try {
      const pageText = pageTextWithFallback(page);
      if (pageText) {
        chunks.push(pageText);
      }
    } finally {
      page.destroy();
    }
  }

  return chunks.join("\n\n").trim();
}

/**
 * MuPDF text extract. Returns "" when the PDF is treated as scanned
 * so the caller must OCR all pages (do not keep partial digital text).
 */
export function extractPdfText(bytes: Buffer): string {
  const doc = openPdfDocument(bytes);
  try {
    if (isScannedPdf(doc)) {
      return "";
    }
    return extractTextFromDoc(doc);
  } finally {
    doc.destroy();
  }
}

export function renderPageJpeg(page: Page): Buffer {
  const [x0, y0, x1, y1] = page.getBounds();
  const nativeW = Math.max(x1 - x0, 1);
  const nativeH = Math.max(y1 - y0, 1);
  const zoom = Math.min(
    VISION_RENDER_ZOOM,
    VISION_MAX_LONG_SIDE_PX / Math.max(nativeW, nativeH)
  );

  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(zoom, zoom),
    mupdf.ColorSpace.DeviceRGB,
    false, // no alpha — required for JPEG
    true // include annotations
  );

  try {
    return Buffer.from(pixmap.asJPEG(VISION_JPEG_QUALITY));
  } finally {
    pixmap.destroy();
  }
}

/** Render a page range to JPEG (0-based inclusive start, exclusive end). */
export function renderPageRangeJpeg(
  doc: Document,
  startIndex: number,
  endIndex: number
): Buffer[] {
  const jpegs: Buffer[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const page = doc.loadPage(i);
    try {
      jpegs.push(renderPageJpeg(page));
    } finally {
      page.destroy();
    }
  }
  return jpegs;
}

/** Render every page to JPEG (only used for scanned PDFs → OCR agent). */
export function renderAllPagesJpeg(bytes: Buffer): Buffer[] {
  const doc = openPdfDocument(bytes);
  try {
    return renderPageRangeJpeg(doc, 0, doc.countPages());
  } finally {
    doc.destroy();
  }
}
