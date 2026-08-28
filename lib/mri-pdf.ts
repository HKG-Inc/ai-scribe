import mupdf, { Document, type Page } from "mupdf";

export const VISION_RENDER_ZOOM = 2.0;
export const VISION_MAX_LONG_SIDE_PX = 2560;
export const VISION_JPEG_QUALITY = 95;

const SCANNED_PAGE_TEXT_THRESHOLD = 50;
const SCANNED_SAMPLE_PAGES = 3;
const SCANNED_MAJORITY = 2;
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

function pageTextWithFallback(page: Page): string {
  let text = pagePlainText(page).trim();
  if (text.length > SHORT_PAGE_TEXT_THRESHOLD) {
    return text;
  }

  const spanText = extractSpansFromJson(
    page.toStructuredText("preserve-spans").asJSON()
  ).trim();

  if (spanText.length > text.length) {
    return spanText;
  }

  return text;
}

export function isPdfBytes(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF";
}

export function decodeTextFile(bytes: Buffer): string {
  const utf8 = bytes.toString("utf8");
  if (utf8.includes("\uFFFD")) {
    return bytes.toString("latin1");
  }
  return utf8;
}

function openPdfDocument(bytes: Buffer): Document {
  return Document.openDocument(bytes, "application/pdf");
}

export function isScannedPdf(doc: Document): boolean {
  const pageCount = doc.countPages();
  const sample = Math.min(SCANNED_SAMPLE_PAGES, pageCount);
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

  return scanned >= SCANNED_MAJORITY;
}

export function extractPdfText(bytes: Buffer): string {
  const doc = openPdfDocument(bytes);
  try {
    if (isScannedPdf(doc)) {
      return "";
    }

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
    false,
    true
  );

  try {
    return Buffer.from(pixmap.asJPEG(VISION_JPEG_QUALITY));
  } finally {
    pixmap.destroy();
  }
}

export function renderAllPagesJpeg(bytes: Buffer): Buffer[] {
  const doc = openPdfDocument(bytes);
  const jpegs: Buffer[] = [];

  try {
    const pageCount = doc.countPages();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        jpegs.push(renderPageJpeg(page));
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }

  return jpegs;
}
