import { apiFetch, cleanDateValue, mapFollowUpAppointment } from "@/lib/utils";
import { normalizeMedicationFrequency } from "@/lib/medication";
import { normalizeReferrals } from "@/lib/referrals";
import type { ReportData } from "@/store/slices/recordingSlice";

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
      if (typeof lab.notes === "string" && lab.notes.trim()) {
        mapped.notes = lab.notes.trim();
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

/** Re-run all Orders-tab agent routes from an updated visit-notes message. */
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
