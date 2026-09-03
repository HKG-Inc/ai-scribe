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

function readKey(record: Record<string, unknown>, name: string): unknown {
  if (name in record) return record[name];
  const lower = name.toLowerCase().replace(/_/g, "");
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase().replace(/_/g, "") === lower) return value;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = readKey(record, name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
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
  const firstBracket = withoutFence.indexOf("[");
  const lastBracket = withoutFence.lastIndexOf("]");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    } catch {
      // Try array if object slice failed.
    }
  }

  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      return JSON.parse(withoutFence.slice(firstBracket, lastBracket + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function unwrapValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === "string") {
    const parsed = parseJsonLoose(value);
    return parsed == null ? value : unwrapValue(parsed, depth + 1);
  }
  return value;
}

const STUDY_LIST_KEYS = [
  "studies",
  "study",
  "mri_studies",
  "mriStudies",
  "reports",
  "exams",
];

function looksLikeStudy(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Boolean(
    readString(record, "filename", "region", "human_label", "humanLabel") ||
      readString(record, "findings_text", "findingsText", "impressions_text") ||
      Array.isArray(readKey(record, "findings"))
  );
}

function studiesFromUnknown(value: unknown, depth = 0): unknown[] {
  if (depth > 6 || value == null) return [];

  const unwrapped = unwrapValue(value);
  if (Array.isArray(unwrapped)) {
    if (unwrapped.some(looksLikeStudy) || unwrapped.some((item) => typeof item === "string")) {
      return unwrapped;
    }
    for (const item of unwrapped) {
      const nested = studiesFromUnknown(item, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }

  const record = asRecord(unwrapped);
  if (!record) return [];

  for (const key of STUDY_LIST_KEYS) {
    const raw = readKey(record, key);
    if (raw == null) continue;
    const nested = studiesFromUnknown(raw, depth + 1);
    if (nested.length) return nested;
  }

  for (const key of [
    "final_output",
    "formatted_output",
    "clinical_summary",
    "data",
    "result",
    "output",
    "content",
    "summary",
    "text",
  ]) {
    const nested = studiesFromUnknown(readKey(record, key), depth + 1);
    if (nested.length) return nested;
  }

  if (looksLikeStudy(record)) return [record];
  return [];
}

/**
 * Walk the Hikigai invoke envelope (`output` is the schema object).
 * Also accepts `output` as a studies array or JSON/markdown string.
 */
export function extractMriAgentOutput(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};

  const studies = studiesFromUnknown(root.output);
  if (studies.length) {
    const outputRecord = asRecord(unwrapValue(root.output));
    return {
      ...(outputRecord ?? {}),
      studies,
    };
  }

  const fromRest = studiesFromUnknown(root);
  if (fromRest.length) {
    return { ...root, studies: fromRest };
  }

  const outputRecord =
    asRecord(unwrapValue(root.output)) ||
    asRecord(unwrapValue(root.content)) ||
    asRecord(unwrapValue(asRecord(root.response)?.output)) ||
    asRecord(unwrapValue(asRecord(root.response)?.content)) ||
    {};

  return outputRecord;
}

/** Compact envelope description for 500s — no full MRI text. */
export function describeMriAgentEnvelope(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return `type=${typeof payload}`;

  const output = root.output;
  let outputDesc = "undefined";
  if (output === null) {
    outputDesc = "null";
  } else if (typeof output === "string") {
    outputDesc = `string(len=${output.length})`;
  } else if (Array.isArray(output)) {
    outputDesc = `array(len=${output.length})`;
  } else if (typeof output === "object") {
    outputDesc = `object keys=${Object.keys(output).join(",") || "(empty)"}`;
  } else if (output !== undefined) {
    outputDesc = typeof output;
  }

  return `keys=${Object.keys(root).join(",")} output=${outputDesc}`;
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
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (!Array.isArray(raw)) return [];
  return raw as Array<MriFinding | string>;
}

function studyFromProse(text: string): MriStudy {
  return {
    filename: "",
    region: "",
    human_label: "",
    date: "",
    contrast: "",
    doctor_name: "",
    findings_text: text,
    impressions_text: "",
    findings: [text],
  };
}

function normalizeStudy(raw: Record<string, unknown>): MriStudy {
  return {
    filename: readString(raw, "filename"),
    region: readString(raw, "region"),
    human_label: readString(raw, "human_label", "humanLabel", "label"),
    date: readString(raw, "date"),
    contrast: readString(raw, "contrast"),
    doctor_name: readString(raw, "doctor_name", "doctorName", "physician"),
    findings_text: readString(raw, "findings_text", "findingsText"),
    impressions_text: readString(raw, "impressions_text", "impressionsText"),
    findings: normalizeFindings(readKey(raw, "findings")),
  };
}

function toStudy(item: unknown): MriStudy | null {
  if (typeof item === "string" && item.trim()) {
    return studyFromProse(item.trim());
  }
  const record = asRecord(unwrapValue(item));
  if (!record) return null;
  return normalizeStudy(record);
}

export function parseSummaryOutput(payload: unknown): MriClinicalSummaryData {
  const output = extractMriAgentOutput(payload);
  const patient_label =
    readString(output, "patient_label", "patientLabel") || "PATIENT 1";

  let studies = studiesFromUnknown(output.studies)
    .map(toStudy)
    .filter((item): item is MriStudy => item !== null);

  if (!studies.length) {
    studies = studiesFromUnknown(output)
      .map(toStudy)
      .filter((item): item is MriStudy => item !== null);
  }

  if (!studies.length) {
    const prose = readString(output, "content", "summary", "text", "extracted_text");
    if (prose) studies = [studyFromProse(prose)];
  }

  return { patient_label, studies };
}
