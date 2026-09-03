export const MRI_OCR_AGENT = "mri-report-ocr-agent";
export const MRI_SUMMARY_AGENT = "mri-clinical-summary-agent";
export const MRI_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse JSON from plain or markdown-fenced agent content. */
function parseJsonLoose(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    // Fall through — model often wraps JSON in prose / fences mid-string.
  }

  const firstBrace = withoutFence.indexOf("{");
  const lastBrace = withoutFence.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return asRecord(parseJsonLoose(value));
  }
  return null;
}

function hasStudies(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  if (Array.isArray(record.studies) && record.studies.length > 0) return true;
  if (typeof record.studies === "string" && record.studies.trim()) return true;
  return false;
}

/**
 * Walk common Hikigai envelopes and pick the record that actually carries
 * `{ patient_label, studies }`. Avoids short-circuiting on an empty `output`.
 */
export function extractMriAgentOutput(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};

  const response = asRecord(root.response);
  const candidates: Array<Record<string, unknown> | null> = [
    coerceRecord(root.output),
    coerceRecord(response?.output),
    coerceRecord(root.content),
    coerceRecord(response?.content),
    coerceRecord(root.result),
    coerceRecord(root.data),
    coerceRecord(asRecord(root.output)?.formatted_output),
    coerceRecord(asRecord(root.output)?.final_output),
    coerceRecord(response?.formatted_output),
    coerceRecord(response?.final_output),
    root,
    response,
  ];

  for (const candidate of candidates) {
    if (hasStudies(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }

  // Deep scan: platform sometimes nests schema under an unexpected key.
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      if (hasStudies(record)) return record;
      for (const value of Object.values(record)) {
        if (typeof value === "string" && value.includes("{")) {
          const parsed = coerceRecord(value);
          if (hasStudies(parsed)) return parsed as Record<string, unknown>;
        } else if (value && typeof value === "object") {
          queue.push(value);
        }
      }
    } else {
      for (const item of current) queue.push(item);
    }
  }

  return (
    coerceRecord(root.output) ||
    coerceRecord(response?.output) ||
    coerceRecord(root.content) ||
    coerceRecord(response?.content) ||
    root
  );
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

function coerceStudies(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = parseJsonLoose(raw);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

export function parseSummaryOutput(payload: unknown): MriClinicalSummaryData {
  const output = extractMriAgentOutput(payload);
  const patient_label =
    typeof output.patient_label === "string" && output.patient_label.trim()
      ? output.patient_label.trim()
      : "PATIENT 1";

  const studiesRaw = coerceStudies(output.studies);
  const studies = studiesRaw
    .map((item) =>
      item && typeof item === "object"
        ? normalizeStudy(item as Record<string, unknown>)
        : null
    )
    .filter((item): item is MriStudy => item !== null);

  return { patient_label, studies };
}
