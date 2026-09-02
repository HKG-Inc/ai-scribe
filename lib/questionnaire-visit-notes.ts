export const QUESTIONNAIRE_VISIT_NOTE_AGENTS = [
  "questionnaire-chief-complaint-agent",
  "questionnaire-msk-agent",
  "questionnaire-tbi-agent",
  "questionnaire-medical-agent",
  "questionnaire-functionality-agent",
] as const;

export type QuestionnaireVisitNoteAgent =
  (typeof QUESTIONNAIRE_VISIT_NOTE_AGENTS)[number];

export interface QuestionnaireQAItem {
  question_text: string;
  answer_text: string;
}

export interface QuestionnaireVisitNotesSections {
  chief_complaint: string;
  msk: string;
  tbi: string;
  medical: string;
  functionality: string;
}

export interface QuestionnaireVisitNotesResult {
  format_type: "questionnaire";
  visit_notes: QuestionnaireVisitNotesSections;
  tbi_symptom_reasoning: Record<string, unknown>;
  tbi_symptom_statuses: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatVisitDate(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}

/** Build the shared combined message for all five questionnaire visit-note agents. */
export function buildQuestionnaireCombinedMessage(
  transcriptionText: string,
  questionnaireResponses: QuestionnaireQAItem[] = [],
  visitDate = new Date()
): string {
  const visitDateStr = formatVisitDate(visitDate);
  const header =
    "SYSTEM_VISIT_DATE_CONTEXT:\n" +
    `- VISIT_DATE: ${visitDateStr}\n` +
    "- Use VISIT_DATE as the reference point to convert any relative accident date phrases " +
    "(for example: 'today', 'yesterday', '3 days ago', 'last Monday', 'two weeks ago') into an " +
    "exact calendar date in MM/DD/YY format for the phrase 'The patient was involved in MVA on [DATE].'.\n" +
    "- If no specific accident date is mentioned anywhere in the questionnaire responses or visit notes, " +
    "omit the 'on [DATE]' phrase completely and simply write 'The patient was involved in MVA.' " +
    "(never use '?', '??', 'Unknown', or any placeholder for the date).\n\n";

  const nonEmptyQa = questionnaireResponses.filter(
    (item) => item.question_text?.trim() || item.answer_text?.trim()
  );

  let qaBlock: string;
  if (nonEmptyQa.length > 0) {
    const qaLines = nonEmptyQa
      .map(
        (item) =>
          `Q: ${item.question_text.trim()}\nA: ${item.answer_text.trim()}\n\n`
      )
      .join("");
    qaBlock =
      "=== PATIENT QUESTIONNAIRE RESPONSES ===\n" +
      qaLines +
      "=== DOCTOR'S VISIT NOTES ===\n";
  } else {
    qaBlock = "=== DOCTOR'S VISIT NOTES (No Questionnaire Data) ===\n";
  }

  return header + qaBlock + transcriptionText.trim();
}

function flattenAgentRecord(record: Record<string, unknown>): Record<string, unknown> {
  const formatted = asRecord(record.formatted_output);
  const finalOutput = asRecord(record.final_output);

  return {
    ...record,
    ...(formatted ?? {}),
    ...(finalOutput ?? {}),
  };
}

export function extractAgentOutput(payload: unknown): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) return {};

  const nested =
    asRecord(root.output) ||
    asRecord(root.result) ||
    asRecord(root.data) ||
    root;

  return flattenAgentRecord(nested);
}

function stripCcPrefix(text: string): string {
  return text.replace(/^Chief Complaint:\s*/i, "").trim();
}

function stripTbiHeader(text: string): string {
  return text
    .replace(/^B\)\s*TBI\s*(\(Traumatic Brain Injury\))?:\s*\n?/i, "")
    .trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

export function mergeQuestionnaireAgentOutputs(outputs: {
  chiefComplaint: Record<string, unknown>;
  msk: Record<string, unknown>;
  tbi: Record<string, unknown>;
  medical: Record<string, unknown>;
  functionality: Record<string, unknown>;
}): QuestionnaireVisitNotesResult {
  let chiefComplaint =
    asString(outputs.chiefComplaint.chief_complaint) ||
    asString(outputs.chiefComplaint.chief_complaint_section);
  chiefComplaint = stripCcPrefix(chiefComplaint);

  const msk =
    asString(outputs.msk.msk) || asString(outputs.msk.msk_section);

  const tbiFields = flattenAgentRecord(outputs.tbi);
  let tbi =
    asString(tbiFields.tbi) ||
    asString(tbiFields.structured_section) ||
    asString(tbiFields.inline_summary);
  if (!tbi) {
    tbi =
      asString(asRecord(tbiFields.formatted_output)?.structured_section) ||
      asString(asRecord(tbiFields.formatted_output)?.inline_summary) ||
      asString(asRecord(tbiFields.final_output)?.structured_section) ||
      asString(asRecord(tbiFields.final_output)?.inline_summary);
  }
  tbi = stripTbiHeader(tbi);

  const medical = asString(outputs.medical.medical);
  const functionality = asString(outputs.functionality.functionality);

  return {
    format_type: "questionnaire",
    visit_notes: {
      chief_complaint: chiefComplaint,
      msk,
      tbi,
      medical,
      functionality,
    },
    tbi_symptom_reasoning: asObject(
      tbiFields.tbi_symptom_reasoning ?? tbiFields.symptom_reasoning
    ),
    tbi_symptom_statuses: asObject(
      tbiFields.tbi_symptom_statuses ?? tbiFields.symptom_statuses
    ),
  };
}

export const QUESTIONNAIRE_VISIT_NOTE_SECTION_LABELS = [
  "A) Chief Complaint",
  "B) MSK",
  "C) TBI",
  "D) Medical",
  "E) Functionality",
] as const;

const QUESTIONNAIRE_VISIT_NOTE_SECTION_KEYS: Array<
  keyof QuestionnaireVisitNotesSections
> = ["chief_complaint", "msk", "tbi", "medical", "functionality"];

const EMPTY_SECTION_PLACEHOLDER = "Not discussed";

/** Flatten structured sections into one display string for the report UI. */
export function formatQuestionnaireVisitNotesText(
  sections: QuestionnaireVisitNotesSections
): string {
  return QUESTIONNAIRE_VISIT_NOTE_SECTION_LABELS.map((label, index) => {
    const key = QUESTIONNAIRE_VISIT_NOTE_SECTION_KEYS[index];
    const text = sections[key].trim() || EMPTY_SECTION_PLACEHOLDER;
    return `${label}\n${text}`;
  }).join("\n\n");
}

function isVisitNotesSections(value: unknown): value is QuestionnaireVisitNotesSections {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    "chief_complaint" in row ||
    "msk" in row ||
    "tbi" in row ||
    "medical" in row ||
    "functionality" in row
  );
}

/** Map /api/visit-notes response into the report store's `visitNotes: string[]`. */
export function mapVisitNotesApiResponseToDisplay(data: {
  visit_notes?: unknown;
  visit_notes_text?: unknown;
}): string[] {
  if (Array.isArray(data.visit_notes_text)) {
    const lines = data.visit_notes_text.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    if (lines.length > 0) return [lines.join("\n\n")];
  }

  if (isVisitNotesSections(data.visit_notes)) {
    const text = formatQuestionnaireVisitNotesText(data.visit_notes);
    return text ? [text] : [];
  }

  if (Array.isArray(data.visit_notes)) {
    const lines = data.visit_notes.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
    return lines.length > 0 ? [lines.join("\n\n")] : [];
  }

  if (typeof data.visit_notes === "string" && data.visit_notes.trim()) {
    return [data.visit_notes.trim()];
  }

  return [];
}

export function qaHistoryToQuestionnaireResponses(
  qaHistory: Array<{
    questionEn: string;
    responseEn?: string;
    responseTranslated: { english_translation: string; original_text?: string } | null;
  }>
): QuestionnaireQAItem[] {
  return qaHistory.map((qa) => ({
    question_text: qa.questionEn,
    answer_text:
      qa.responseTranslated?.english_translation ||
      qa.responseEn ||
      qa.responseTranslated?.original_text ||
      "Skipped",
  }));
}
