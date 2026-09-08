import { apiFetch, cleanDateValue, mapFollowUpAppointment } from "@/lib/utils";
import { normalizeMedicationFrequency } from "@/lib/medication";
import { normalizeReferrals } from "@/lib/referrals";
import type { QuestionnaireQAItem } from "@/lib/questionnaire-visit-notes";
import type { ReportData, ReportSectionKey } from "@/store/slices/recordingSlice";
import {
  diffVisitNotesSections,
  getAgentsForChangedSections,
  buildCpt2UpdateMessage,
  buildCptUpdateMessage,
  buildEmUpdateMessage,
  buildFollowUpUpdateMessage,
  buildIcdUpdateMessage,
  buildLabTestsUpdateMessage,
  buildMedicationUpdateMessage,
  buildProceduresUpdateMessage,
  buildReferralsUpdateMessage,
  buildSoapUpdateMessage,
  buildVaccinesUpdateMessage,
  type VisitNotesUpdateAgent,
} from "@/lib/visit-notes-update";

function todayMmDdYyyy(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

async function callAgentRoute<T>(
  url: string,
  message: string,
  extraBody?: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...extraBody }),
    });

    const data = (await response.json()) as T & { error?: string };
    const responseError =
      typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;

    if (!response.ok || responseError) {
      return {
        ok: false,
        error: responseError || `Request failed for ${url}`,
      };
    }

    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `Request failed for ${url}`,
    };
  }
}

function mapMedications(
  items: unknown[],
  today: string
): ReportData["medication"]["prescribed_medications"] {
  return items
    .map((item) => {
      if (typeof item === "string") {
        return {
          correct_medicine_name: item,
          dosage: "",
          unit: "",
          frequency: { morning: null, afternoon: null, night: null },
          start_date: today,
          days: "",
          instruction: "",
        };
      }

      if (item && typeof item === "object") {
        const med = item as {
          correct_medicine_name?: unknown;
          medicine_name?: unknown;
          name?: unknown;
          dosage?: unknown;
          unit?: unknown;
          start_date?: unknown;
          days?: unknown;
          instruction?: unknown;
          frequency?: unknown;
        };

        const medicineName =
          typeof med.correct_medicine_name === "string"
            ? med.correct_medicine_name
            : typeof med.medicine_name === "string"
              ? med.medicine_name
              : typeof med.name === "string"
                ? med.name
                : "";

        if (!medicineName) {
          return null;
        }

        return {
          correct_medicine_name: medicineName,
          dosage: typeof med.dosage === "string" ? med.dosage : "",
          unit: typeof med.unit === "string" ? med.unit : "",
          frequency: normalizeMedicationFrequency(med.frequency),
          start_date:
            typeof med.start_date === "string" && med.start_date ? med.start_date : today,
          days: typeof med.days === "string" ? med.days : "",
          instruction: typeof med.instruction === "string" ? med.instruction : "",
        };
      }

      return null;
    })
    .filter(
      (item): item is ReportData["medication"]["prescribed_medications"][number] =>
        item !== null
    );
}

function mapProcedures(items: unknown[]): Record<string, unknown>[] {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const procedure = item as {
        name?: unknown;
        reason?: unknown;
        notes?: unknown;
        procedure_name?: unknown;
        clinical_context?: unknown;
        date?: unknown;
        procedure_type?: unknown;
      };

      const name =
        typeof procedure.name === "string"
          ? procedure.name
          : typeof procedure.procedure_name === "string"
            ? procedure.procedure_name
            : "";

      if (!name.trim()) {
        return null;
      }

      const mapped: Record<string, unknown> = { name };
      const date = cleanDateValue(procedure.date);
      if (date) {
        mapped.date = date;
      }
      if (typeof procedure.procedure_type === "string" && procedure.procedure_type.trim()) {
        mapped.procedure_type = procedure.procedure_type;
      }
      const note =
        typeof procedure.notes === "string" && procedure.notes.trim()
          ? procedure.notes
          : typeof procedure.reason === "string" && procedure.reason.trim()
            ? procedure.reason
            : typeof procedure.clinical_context === "string" &&
                procedure.clinical_context.trim()
              ? procedure.clinical_context
              : "";
      if (note) {
        mapped.notes = note;
      }

      return mapped;
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function mapLabTests(items: unknown[]): Record<string, unknown>[] {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const lab = item as {
        name?: unknown;
        test_name?: unknown;
        date?: unknown;
        notes?: unknown;
        reason?: unknown;
      };

      const name =
        typeof lab.name === "string"
          ? lab.name
          : typeof lab.test_name === "string"
            ? lab.test_name
            : "";
      if (!name.trim()) return null;

      const mapped: Record<string, unknown> = { name };
      const date = cleanDateValue(lab.date);
      if (date) {
        mapped.date = date;
      }
      const notes =
        typeof lab.notes === "string" && lab.notes.trim()
          ? lab.notes.trim()
          : typeof lab.reason === "string" && lab.reason.trim()
            ? lab.reason.trim()
            : "";
      if (notes) {
        mapped.notes = notes;
      }

      return mapped;
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function mapVaccines(items: unknown[]): Array<{ name: string; dose?: string; date?: string }> {
  return items
    .map((item) => {
      if (typeof item === "string") {
        return item.trim() ? { name: item.trim() } : null;
      }
      if (!item || typeof item !== "object") return null;
      const vaccine = item as {
        name?: unknown;
        vaccine_name?: unknown;
        vaccineName?: unknown;
        dose?: unknown;
        dose_number?: unknown;
        doseNumber?: unknown;
        date?: unknown;
        vaccinationDate?: unknown;
      };
      const name =
        typeof vaccine.name === "string"
          ? vaccine.name
          : typeof vaccine.vaccine_name === "string"
            ? vaccine.vaccine_name
            : typeof vaccine.vaccineName === "string"
              ? vaccine.vaccineName
              : "";
      if (!name.trim()) return null;
      const dose =
        typeof vaccine.dose === "string"
          ? vaccine.dose
          : typeof vaccine.dose_number === "string"
            ? vaccine.dose_number
            : typeof vaccine.doseNumber === "string"
              ? vaccine.doseNumber
              : "";
      const date =
        typeof vaccine.date === "string"
          ? vaccine.date
          : typeof vaccine.vaccinationDate === "string"
            ? vaccine.vaccinationDate
            : "";
      return {
        name,
        ...(dose ? { dose } : {}),
        ...(date.trim() ? { date } : {}),
      };
    })
    .filter((item): item is { name: string; dose?: string; date?: string } => item !== null);
}

/** @deprecated Prefer regenerateFromVisitNotesUpdate for questionnaire edit flow. */
export async function fetchOrdersPatchFromMessage(
  message: string
): Promise<Partial<ReportData>> {
  const today = todayMmDdYyyy();
  const patch: Partial<ReportData> = {};
  const warnings: string[] = [];

  const [
    medicationsResult,
    labTestsResult,
    followUpResult,
    proceduresResult,
    referralsResult,
    vaccinesResult,
  ] = await Promise.all([
    callAgentRoute<{ medication?: unknown[] }>("/api/medications", message, {
      current_date: today,
    }),
    callAgentRoute<{ lab_test?: unknown[] }>("/api/lab-tests", message, {
      current_date: today,
    }),
    callAgentRoute<{ follow_ups?: unknown[] }>("/api/follow-ups", message, {
      current_date: today,
    }),
    callAgentRoute<{ procedure?: unknown[]; procedures?: unknown[] }>(
      "/api/procedures",
      message,
      { current_date: today }
    ),
    callAgentRoute<{ referrals?: unknown[] }>("/api/referrals", message),
    callAgentRoute<{ vaccine?: unknown[] }>("/api/vaccines", message, {
      current_date: today,
    }),
  ]);

  if (medicationsResult.ok) {
    patch.medication = {
      prescribed_medications: mapMedications(medicationsResult.data.medication || [], today),
      in_clinic_medications: [],
    };
  } else {
    warnings.push(medicationsResult.error);
  }

  if (labTestsResult.ok) {
    patch.labtest = {
      lab_test: mapLabTests(labTestsResult.data.lab_test || []),
    };
  } else {
    warnings.push(labTestsResult.error);
  }

  if (followUpResult.ok) {
    const firstFollowUp = (followUpResult.data.follow_ups || [])[0];
    patch.followup = {
      follow_up_appointment: mapFollowUpAppointment(firstFollowUp),
    };
  } else {
    warnings.push(followUpResult.error);
  }

  if (proceduresResult.ok) {
    patch.procedure = {
      procedure: mapProcedures(
        proceduresResult.data.procedure || proceduresResult.data.procedures || []
      ),
    };
  } else {
    warnings.push(proceduresResult.error);
  }

  if (referralsResult.ok) {
    patch.referrals = normalizeReferrals({
      referrals: referralsResult.data.referrals || [],
    });
  } else {
    warnings.push(referralsResult.error);
  }

  if (vaccinesResult.ok) {
    patch.vaccine = {
      vaccine: mapVaccines(vaccinesResult.data.vaccine || []),
    };
  } else {
    warnings.push(vaccinesResult.error);
  }

  if (warnings.length > 0) {
    console.warn("[regenerate-orders] Some order agents failed:", warnings);
  }

  return patch;
}

const AGENT_TO_SECTION: Record<VisitNotesUpdateAgent, ReportSectionKey> = {
  soap: "soapNote",
  medication: "medication",
  labtest: "labtest",
  procedure: "procedure",
  followup: "followup",
  vaccine: "vaccine",
  referrals: "referrals",
  icd: "icdCodes",
  cpt: "cptCodes",
  em: "emCodes",
  cpt2: "cpt2Codes",
};

export function loadingSectionsForAgents(
  agents: Iterable<VisitNotesUpdateAgent>
): ReportSectionKey[] {
  return Array.from(new Set(Array.from(agents, (agent) => AGENT_TO_SECTION[agent])));
}

export interface VisitNotesUpdateResult {
  patch: Partial<ReportData>;
  agentsRequested: VisitNotesUpdateAgent[];
  agentsSucceeded: VisitNotesUpdateAgent[];
  warnings: string[];
  changedSections: ReturnType<typeof diffVisitNotesSections>;
}

/**
 * Re-run downstream agents after Dr. Abraham visit-notes edit, using doc-specified
 * inputs (session confirmed blocks / Q&A + updated notes) and section-based skip.
 */
export async function regenerateFromVisitNotesUpdate(options: {
  previousVisitNotes: string;
  updatedVisitNotes: string;
  reportData: ReportData;
  questionnaireResponses: QuestionnaireQAItem[];
}): Promise<VisitNotesUpdateResult> {
  const {
    previousVisitNotes,
    updatedVisitNotes,
    reportData,
    questionnaireResponses,
  } = options;

  const changedSections = diffVisitNotesSections(previousVisitNotes, updatedVisitNotes);
  const agents = getAgentsForChangedSections(changedSections);
  const agentsRequested = Array.from(agents);
  const agentsSucceeded: VisitNotesUpdateAgent[] = [];
  const warnings: string[] = [];
  const patch: Partial<ReportData> = {};
  const today = todayMmDdYyyy();
  const notes = updatedVisitNotes.trim();

  if (agentsRequested.length === 0) {
    console.log(
      "[visit-notes-update] No section changes detected; skipping agent regeneration."
    );
    return {
      patch,
      agentsRequested,
      agentsSucceeded,
      warnings,
      changedSections,
    };
  }

  console.log(
    "[visit-notes-update] changed sections:",
    changedSections,
    "agents:",
    agentsRequested
  );

  const tasks: Array<Promise<void>> = [];

  if (agents.has("soap")) {
    const message = buildSoapUpdateMessage(notes, questionnaireResponses);
    console.log("[visit-notes-update] SOAP invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{
          subjective?: string;
          objective?: string;
          assessment?: string;
          plan?: string;
        }>("/api/soap-notes", message);
        if (!result.ok) {
          warnings.push(`soap: ${result.error}`);
          console.error("[visit-notes-update] SOAP failed:", result.error);
          return;
        }
        const subjective = result.data.subjective?.trim() || "";
        const objective = result.data.objective?.trim() || "";
        const assessment = result.data.assessment?.trim() || "";
        const plan = result.data.plan?.trim() || "";
        patch.soapNote = {
          subjective: subjective ? { subjective } : {},
          objective: objective ? { objective } : {},
          assessment: assessment ? { assessment } : {},
          plan: plan ? { plan } : {},
        };
        agentsSucceeded.push("soap");
      })()
    );
  }

  if (agents.has("medication")) {
    const message = buildMedicationUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] medication invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ medication?: unknown[] }>(
          "/api/medications",
          message,
          { current_date: today }
        );
        if (!result.ok) {
          warnings.push(`medication: ${result.error}`);
          console.error("[visit-notes-update] medication failed:", result.error);
          return;
        }
        patch.medication = {
          prescribed_medications: mapMedications(result.data.medication || [], today),
          in_clinic_medications: [],
        };
        agentsSucceeded.push("medication");
      })()
    );
  }

  if (agents.has("labtest")) {
    const message = buildLabTestsUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] labtest invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ lab_test?: unknown[] }>(
          "/api/lab-tests",
          message,
          { current_date: today }
        );
        if (!result.ok) {
          warnings.push(`labtest: ${result.error}`);
          console.error("[visit-notes-update] labtest failed:", result.error);
          return;
        }
        patch.labtest = { lab_test: mapLabTests(result.data.lab_test || []) };
        agentsSucceeded.push("labtest");
      })()
    );
  }

  if (agents.has("procedure")) {
    const message = buildProceduresUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] procedure invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{
          procedure?: unknown[];
          procedures?: unknown[];
        }>("/api/procedures", message, { current_date: today });
        if (!result.ok) {
          warnings.push(`procedure: ${result.error}`);
          console.error("[visit-notes-update] procedure failed:", result.error);
          return;
        }
        patch.procedure = {
          procedure: mapProcedures(result.data.procedure || result.data.procedures || []),
        };
        agentsSucceeded.push("procedure");
      })()
    );
  }

  if (agents.has("followup")) {
    const message = buildFollowUpUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] followup invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ follow_ups?: unknown[] }>(
          "/api/follow-ups",
          message,
          { current_date: today }
        );
        if (!result.ok) {
          warnings.push(`followup: ${result.error}`);
          console.error("[visit-notes-update] followup failed:", result.error);
          return;
        }
        const firstFollowUp = (result.data.follow_ups || [])[0];
        patch.followup = {
          follow_up_appointment: mapFollowUpAppointment(firstFollowUp),
        };
        agentsSucceeded.push("followup");
      })()
    );
  }

  if (agents.has("vaccine")) {
    const message = buildVaccinesUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] vaccine invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ vaccine?: unknown[] }>(
          "/api/vaccines",
          message,
          { current_date: today }
        );
        if (!result.ok) {
          warnings.push(`vaccine: ${result.error}`);
          console.error("[visit-notes-update] vaccine failed:", result.error);
          return;
        }
        patch.vaccine = { vaccine: mapVaccines(result.data.vaccine || []) };
        agentsSucceeded.push("vaccine");
      })()
    );
  }

  if (agents.has("referrals")) {
    const message = buildReferralsUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] referrals invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ referrals?: unknown[] }>(
          "/api/referrals",
          message
        );
        if (!result.ok) {
          warnings.push(`referrals: ${result.error}`);
          console.error("[visit-notes-update] referrals failed:", result.error);
          return;
        }
        patch.referrals = normalizeReferrals({ referrals: result.data.referrals || [] });
        agentsSucceeded.push("referrals");
      })()
    );
  }

  if (agents.has("icd")) {
    const message = buildIcdUpdateMessage(notes);
    console.log("[visit-notes-update] icd invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{
          icd_codes?: Array<{ icd_10_code: string; name: string }>;
        }>("/api/icd-10-codes", message);
        if (!result.ok) {
          warnings.push(`icd: ${result.error}`);
          console.error("[visit-notes-update] icd failed:", result.error);
          return;
        }
        patch.icdCodes = { icd_codes: result.data.icd_codes || [] };
        agentsSucceeded.push("icd");
      })()
    );
  }

  if (agents.has("cpt")) {
    const message = buildCptUpdateMessage(notes);
    console.log("[visit-notes-update] cpt invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{
          cpt_codes?: Array<{ cpt_code: string; name: string }>;
        }>("/api/cpt-pipeline", message);
        if (!result.ok) {
          warnings.push(`cpt: ${result.error}`);
          console.error("[visit-notes-update] cpt failed:", result.error);
          return;
        }
        patch.cptCodes = { cpt_codes: result.data.cpt_codes || [] };
        agentsSucceeded.push("cpt");
      })()
    );
  }

  if (agents.has("em")) {
    const message = buildEmUpdateMessage(notes, reportData);
    console.log("[visit-notes-update] em invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{ em_code?: string; description?: string }>(
          "/api/em-code",
          message
        );
        if (!result.ok) {
          warnings.push(`em: ${result.error}`);
          console.error("[visit-notes-update] em failed:", result.error);
          return;
        }
        patch.emCodes = {
          em_code: result.data.em_code || "",
          description: result.data.description || "",
        };
        agentsSucceeded.push("em");
      })()
    );
  }

  if (agents.has("cpt2")) {
    const message = buildCpt2UpdateMessage(notes, reportData);
    console.log("[visit-notes-update] cpt2 invoke input:", message.slice(0, 500));
    tasks.push(
      (async () => {
        const result = await callAgentRoute<{
          codes?: Array<{ cpt2_code: string; description: string }>;
        }>("/api/cpt2-codes", message);
        if (!result.ok) {
          warnings.push(`cpt2: ${result.error}`);
          console.error("[visit-notes-update] cpt2 failed:", result.error);
          return;
        }
        patch.cpt2Codes = { codes: result.data.codes || [] };
        agentsSucceeded.push("cpt2");
      })()
    );
  }

  await Promise.all(tasks);

  if (warnings.length > 0) {
    console.warn("[visit-notes-update] Some agents failed:", warnings);
  } else {
    console.log(
      "[visit-notes-update] All requested agents succeeded:",
      agentsSucceeded
    );
  }

  return {
    patch,
    agentsRequested,
    agentsSucceeded,
    warnings,
    changedSections,
  };
}
