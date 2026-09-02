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

/**
 * Prefer response.output (structured schema). Fall back to parsing
 * response.content when output is missing or a JSON string.
 */
export function extractMriAgentOutput(payload: unknown): Record<string, unknown> {
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

  const response = asRecord(root.response);

  return (
    tryParse(root.output) ||
    tryParse(response?.output) ||
    tryParse(root.content) ||
    tryParse(response?.content) ||
    tryParse(root.result) ||
    tryParse(root.data) ||
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

export function parseSummaryOutput(payload: unknown): MriClinicalSummaryData {
  const output = extractMriAgentOutput(payload);
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
