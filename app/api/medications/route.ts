import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";
import { normalizeMedicationFrequency } from "@/lib/medication";

export const maxDuration = 300;

interface MedicationRequest {
  message?: string;
  current_date?: string;
}

function todayMMDDYYYY(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

type MedicationItem = {
  correct_medicine_name: string;
  dosage: string;
  unit: string;
  frequency: { morning: string | null; afternoon: string | null; night: string | null };
  start_date: string;
  days: string;
  instruction: string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMedicationItem(entry: unknown): MedicationItem | null {
  if (typeof entry === "string") {
    const name = entry.trim();
    return name
      ? {
          correct_medicine_name: name,
          dosage: "",
          unit: "",
          frequency: { morning: null, afternoon: null, night: null },
          start_date: "",
          days: "",
          instruction: "",
        }
      : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const item = entry as Record<string, unknown>;
  const medicineName =
    str(item.correct_medicine_name) ??
    str(item.medicine_name) ??
    str(item.medicineName) ??
    str(item.name) ??
    "";

  if (!medicineName) {
    return null;
  }

  return {
    correct_medicine_name: medicineName,
    dosage: str(item.dosage) ?? str(item.dose) ?? "",
    unit: str(item.unit) ?? "",
    frequency: normalizeMedicationFrequency(item.frequency),
    start_date: str(item.start_date) ?? str(item.startDate) ?? "",
    days: str(item.days) ?? "",
    instruction: str(item.instruction) ?? str(item.instructions) ?? "",
  };
}

function normalizeMedication(payload: unknown): MedicationItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    medication?: unknown;
    output?: {
      medication?: unknown;
    };
    data?: {
      medication?: unknown;
    };
  };

  const medication = data.medication ?? data.output?.medication ?? data.data?.medication;
  if (!Array.isArray(medication)) {
    return [];
  }

  return medication
    .map((entry) => normalizeMedicationItem(entry))
    .filter((item): item is MedicationItem => item !== null);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MedicationRequest;
    const message = body.message?.trim();
    const current_date = body.current_date?.trim() || todayMMDDYYYY();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentInput = { message, current_date };
    const agentResponse = await hikigai.invokeAgent(
      "medication-agent",
      agentInput,
      HIKIGAI_AGENT_TIMEOUT_MS
    );
    const medication = normalizeMedication(agentResponse);
    logger.agentInvokeOk("medication-agent", {
      rawResponse: agentResponse,
      normalized: { medication },
      extra: { invokeInput: agentInput },
    });
    return NextResponse.json({ medication }, { status: 200 });
  } catch (error) {
    logger.error("medication-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate medication data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
