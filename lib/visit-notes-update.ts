import type { QuestionnaireQAItem } from "@/lib/questionnaire-visit-notes";
import {
  buildSoapNotesCombinedMessage,
  filterAnsweredQuestionnaireResponses,
} from "@/lib/questionnaire-visit-notes";
import type { ReportData } from "@/store/slices/recordingSlice";
import type { ReferralItem } from "@/lib/referrals";
import { normalizeReferrals } from "@/lib/referrals";

/** Editable Dr. Abraham sections used for agent re-trigger diffing. */
export type VisitNotesDiffSection = "msk" | "tbi" | "medical" | "functionality";

export type VisitNotesSectionKey = "chief_complaint" | VisitNotesDiffSection;

export type VisitNotesUpdateAgent =
  | "soap"
  | "medication"
  | "labtest"
  | "procedure"
  | "followup"
  | "vaccine"
  | "referrals"
  | "icd"
  | "cpt"
  | "em"
  | "cpt2";

const SECTION_HEADER_PATTERNS: Array<{ key: VisitNotesSectionKey; re: RegExp }> = [
  { key: "chief_complaint", re: /^A\)\s*CHIEF[_\s-]?COMPLAINT:\s*(.*)$/i },
  { key: "msk", re: /^B\)\s*MSK(?:\s*:\s*History of Present Illness \(HPI\))?:\s*(.*)$/i },
  { key: "tbi", re: /^C\)\s*TBI:\s*(.*)$/i },
  { key: "medical", re: /^D\)\s*MEDICAL:\s*(.*)$/i },
  { key: "functionality", re: /^E\)\s*FUNCTIONALITY:\s*(.*)$/i },
];

const AGENTS_BY_SECTION: Record<VisitNotesDiffSection, VisitNotesUpdateAgent[]> = {
  medical: [
    "medication",
    "labtest",
    "procedure",
    "vaccine",
    "referrals",
    "followup",
    "icd",
    "cpt",
    "em",
    "cpt2",
    "soap",
  ],
  msk: [
    "medication",
    "procedure",
    "referrals",
    "icd",
    "cpt",
    "em",
    "cpt2",
    "soap",
  ],
  tbi: ["icd", "cpt", "em", "cpt2", "soap"],
  functionality: ["followup", "soap"],
};

function normalizeSectionText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Parse A–E questionnaire visit-notes text into section bodies. */
export function parseQuestionnaireVisitNotesSections(
  text: string
): Record<VisitNotesSectionKey, string> {
  const sections: Record<VisitNotesSectionKey, string> = {
    chief_complaint: "",
    msk: "",
    tbi: "",
    medical: "",
    functionality: "",
  };

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let current: VisitNotesSectionKey | null = null;
  const buffers: Record<VisitNotesSectionKey, string[]> = {
    chief_complaint: [],
    msk: [],
    tbi: [],
    medical: [],
    functionality: [],
  };

  for (const line of lines) {
    let matchedHeader = false;
    for (const { key, re } of SECTION_HEADER_PATTERNS) {
      const match = line.trimEnd().match(re);
      if (!match) continue;
      current = key;
      matchedHeader = true;
      const rest = (match[1] ?? "").trim();
      if (rest) buffers[key].push(rest);
      break;
    }
    if (matchedHeader || !current) continue;
    buffers[current].push(line);
  }

  for (const key of Object.keys(sections) as VisitNotesSectionKey[]) {
    sections[key] = buffers[key].join("\n").trim();
  }
  return sections;
}

/** Which of MSK / TBI / Medical / Functionality changed between before and after. */
export function diffVisitNotesSections(
  beforeText: string,
  afterText: string
): VisitNotesDiffSection[] {
  const before = parseQuestionnaireVisitNotesSections(beforeText);
  const after = parseQuestionnaireVisitNotesSections(afterText);
  const changed: VisitNotesDiffSection[] = [];

  for (const key of ["msk", "tbi", "medical", "functionality"] as const) {
    if (normalizeSectionText(before[key]) !== normalizeSectionText(after[key])) {
      changed.push(key);
    }
  }

  // If structure couldn't be parsed but text changed, treat as full medical+msk+tbi+functionality.
  if (
    changed.length === 0 &&
    normalizeSectionText(beforeText) !== normalizeSectionText(afterText)
  ) {
    return ["msk", "tbi", "medical", "functionality"];
  }

  return changed;
}

/** Union of agents to re-invoke for the changed sections. */
export function getAgentsForChangedSections(
  changed: VisitNotesDiffSection[]
): Set<VisitNotesUpdateAgent> {
  const agents = new Set<VisitNotesUpdateAgent>();
  for (const section of changed) {
    for (const agent of AGENTS_BY_SECTION[section]) {
      agents.add(agent);
    }
  }
  return agents;
}

function withSessionBlock(header: string, items: unknown, updatedVisitNotes: string): string {
  return (
    `${header}\n` +
    `${JSON.stringify(items, null, 2)}\n\n` +
    updatedVisitNotes.trim()
  );
}

function frequencyToCsv(
  frequency: ReportData["medication"]["prescribed_medications"][number]["frequency"]
): string {
  const m = frequency?.morning ?? "0";
  const a = frequency?.afternoon ?? "0";
  const n = frequency?.night ?? "0";
  return `${m},${a},${n}`;
}

export function buildConfirmedMedicationsPayload(
  medication: ReportData["medication"]
): unknown[] {
  return (medication.prescribed_medications || []).map((med) => ({
    name: med.correct_medicine_name,
    dosage: med.dosage,
    unit: med.unit,
    frequency: frequencyToCsv(med.frequency),
    instruction: med.instruction,
    start_date: med.start_date,
    days: med.days,
  }));
}

export function buildConfirmedLabTestsPayload(labtest: ReportData["labtest"]): unknown[] {
  return (labtest.lab_test || [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const test_name =
        (typeof row.name === "string" && row.name) ||
        (typeof row.test_name === "string" && row.test_name) ||
        "";
      if (!test_name.trim()) return null;
      const reason =
        (typeof row.notes === "string" && row.notes) ||
        (typeof row.reason === "string" && row.reason) ||
        "";
      return { test_name, reason };
    })
    .filter((item): item is { test_name: string; reason: string } => item !== null);
}

function isImagingProcedure(item: Record<string, unknown>): boolean {
  const type = typeof item.procedure_type === "string" ? item.procedure_type.toLowerCase() : "";
  return type.includes("imaging") || type.includes("radiology");
}

export function buildConfirmedProceduresPayload(
  procedure: ReportData["procedure"]
): unknown[] {
  return (procedure.procedure || [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (isImagingProcedure(row)) return null;
      const procedure_name =
        (typeof row.name === "string" && row.name) ||
        (typeof row.procedure_name === "string" && row.procedure_name) ||
        "";
      if (!procedure_name.trim()) return null;
      const notes = typeof row.notes === "string" ? row.notes : "";
      return { procedure_name, notes };
    })
    .filter((item): item is { procedure_name: string; notes: string } => item !== null);
}

export function buildConfirmedImagingPayload(procedure: ReportData["procedure"]): unknown[] {
  return (procedure.procedure || [])
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (!isImagingProcedure(row)) return null;
      const imaging_order =
        (typeof row.name === "string" && row.name) ||
        (typeof row.procedure_name === "string" && row.procedure_name) ||
        "";
      if (!imaging_order.trim()) return null;
      const reason =
        (typeof row.notes === "string" && row.notes) ||
        (typeof row.reason === "string" && row.reason) ||
        "";
      return { imaging_order, reason };
    })
    .filter((item): item is { imaging_order: string; reason: string } => item !== null);
}

export function buildConfirmedFollowUpPayload(followup: ReportData["followup"]): unknown[] {
  const appt = followup.follow_up_appointment;
  if (!appt) return [];
  return [
    {
      duration: appt.duration || "",
      unit: "",
      reason: appt.reason || "",
    },
  ];
}

export function buildConfirmedVaccinesPayload(vaccine: ReportData["vaccine"]): unknown[] {
  return (vaccine.vaccine || [])
    .map((item) => {
      if (typeof item === "string") {
        return item.trim()
          ? { vaccine_name: item.trim(), status: "Administered" }
          : null;
      }
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const vaccine_name =
        (typeof row.name === "string" && row.name) ||
        (typeof row.vaccine_name === "string" && row.vaccine_name) ||
        "";
      if (!vaccine_name.trim()) return null;
      return {
        vaccine_name,
        status: typeof row.status === "string" && row.status ? row.status : "Administered",
      };
    })
    .filter((item): item is { vaccine_name: string; status: string } => item !== null);
}

export function buildConfirmedReferralsPayload(referrals: ReportData["referrals"]): unknown[] {
  const items: ReferralItem[] = Array.isArray(referrals)
    ? normalizeReferrals({ referrals })
    : [];
  return items.map((item) => ({
    specialty: item.specialty,
    reason: item.reason,
  }));
}

/** SOAP on visit-notes update: answered Q&A + updated notes (no date header, no audio). */
export function buildSoapUpdateMessage(
  updatedVisitNotes: string,
  questionnaireResponses: QuestionnaireQAItem[]
): string {
  const answered = filterAnsweredQuestionnaireResponses(questionnaireResponses);
  return (
    buildSoapNotesCombinedMessage(updatedVisitNotes, answered) || updatedVisitNotes.trim()
  );
}

export function buildMedicationUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== CURRENTLY CONFIRMED MEDICATIONS IN SESSION ===",
    buildConfirmedMedicationsPayload(reportData.medication),
    updatedVisitNotes
  );
}

export function buildLabTestsUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== CURRENTLY CONFIRMED LAB TESTS IN SESSION ===",
    buildConfirmedLabTestsPayload(reportData.labtest),
    updatedVisitNotes
  );
}

/**
 * Procedures agent also owns imaging in this app — send both confirmed blocks
 * then the updated visit notes.
 */
export function buildProceduresUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  const proceduresBlock =
    "=== CURRENTLY CONFIRMED PROCEDURES IN SESSION ===\n" +
    `${JSON.stringify(buildConfirmedProceduresPayload(reportData.procedure), null, 2)}\n\n`;
  const imagingBlock =
    "=== CURRENTLY CONFIRMED IMAGING/RADIOLOGY IN SESSION ===\n" +
    `${JSON.stringify(buildConfirmedImagingPayload(reportData.procedure), null, 2)}\n\n`;
  return proceduresBlock + imagingBlock + updatedVisitNotes.trim();
}

export function buildFollowUpUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== CURRENTLY CONFIRMED FOLLOW-UP IN SESSION ===",
    buildConfirmedFollowUpPayload(reportData.followup),
    updatedVisitNotes
  );
}

export function buildVaccinesUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== CURRENTLY CONFIRMED VACCINES IN SESSION ===",
    buildConfirmedVaccinesPayload(reportData.vaccine),
    updatedVisitNotes
  );
}

export function buildReferralsUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== CURRENTLY CONFIRMED REFERRALS IN SESSION ===",
    buildConfirmedReferralsPayload(reportData.referrals),
    updatedVisitNotes
  );
}

export function buildIcdUpdateMessage(updatedVisitNotes: string): string {
  return updatedVisitNotes.trim();
}

export function buildCptUpdateMessage(updatedVisitNotes: string): string {
  return updatedVisitNotes.trim();
}

export function buildEmUpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  const previous = {
    em_code: reportData.emCodes.em_code || "",
    description: reportData.emCodes.description || "",
  };
  return withSessionBlock(
    "=== PREVIOUS E&M CODE FOR VALIDATION ===",
    previous,
    updatedVisitNotes
  );
}

export function buildCpt2UpdateMessage(
  updatedVisitNotes: string,
  reportData: ReportData
): string {
  return withSessionBlock(
    "=== PREVIOUS CPT-2 CODES FOR VALIDATION ===",
    reportData.cpt2Codes.codes || [],
    updatedVisitNotes
  );
}
