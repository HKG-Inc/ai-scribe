/**
 * Shared Visit Summary line classification for UI + PDF.
 * Matches the clinical A–E screenshot layout (bold headers, anatomy regions, TBI markers).
 */

export type VisitNotesLineKind =
  | "blank"
  | "major"
  | "subheader"
  | "body";

const MAJOR_HEADER_PATTERNS: RegExp[] = [
  /^(A\)\s*CHIEF[_\s-]?COMPLAINT:)\s*(.*)$/i,
  /^(B\)\s*MSK:\s*History of Present Illness \(HPI\):)\s*(.*)$/i,
  /^(B\)\s*MSK:)\s*(.*)$/i,
  /^(C\)\s*TBI:)\s*(.*)$/i,
  /^(D\)\s*MEDICAL:)\s*(.*)$/i,
  /^(E\)\s*FUNCTIONALITY:)\s*(.*)$/i,
  // Legacy labels (pre-normalization)
  /^(A\)\s*Chief Complaint:?)\s*(.*)$/i,
  /^(C\)\s*TBI:?)\s*(.*)$/i,
  /^(D\)\s*Medical:?)\s*(.*)$/i,
  /^(E\)\s*Functionality:?)\s*(.*)$/i,
];

/** Standalone section/region headers with nothing after the colon. */
const SUBHEADER_RE =
  /^(Anatomy-Wise Breakdown|Spine|Upper Extremities|Lower Extremities|Associated Symptoms\s*&\s*Functional Impact|Other Symptoms|SYMPTOMS|HEADACHE PATTERN|DIAGNOSTIC TESTS):$/i;

export function splitMajorHeader(
  line: string
): { label: string; rest: string } | null {
  const trimmed = line.trimEnd();
  for (const pattern of MAJOR_HEADER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        label: match[1].replace(/\s+$/, ""),
        rest: (match[2] ?? "").trim(),
      };
    }
  }
  return null;
}

export function isVisitNotesSubheader(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (splitMajorHeader(t)) return false;
  if (SUBHEADER_RE.test(t)) return true;
  // Generic: short line ending with ":" and no value after the colon.
  if (!t.endsWith(":")) return false;
  if (t.length > 64) return false;
  if (/[\[\]]/.test(t)) return false;
  const after = t.slice(t.indexOf(":") + 1).trim();
  return after.length === 0;
}

export function classifyVisitNotesLine(line: string): VisitNotesLineKind {
  if (!line.trim()) return "blank";
  if (splitMajorHeader(line)) return "major";
  if (isVisitNotesSubheader(line)) return "subheader";
  return "body";
}
