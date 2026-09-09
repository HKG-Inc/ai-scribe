import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface VaccineRequest {
  message?: string;
  current_date?: string;
}

type VaccineItem = {
  name: string;
  dose?: string;
  date?: string;
};

function todayMMDDYYYY(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  });
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTextVaccines(text: string): VaccineItem[] {
  const items: VaccineItem[] = [];
  const blocks = text.split(/vaccine\s*\d+\s*:/i).map((block) => block.trim());

  for (const block of blocks) {
    if (!block) continue;
    const nameMatch = block.match(/name\s*:\s*(.+)/i);
    const doseMatch = block.match(/dose\s*:\s*(.+)/i);
    const dateMatch = block.match(/date\s*:\s*(.+)/i);
    const name = nameMatch?.[1]?.trim();
    if (!name) continue;
    items.push({
      name,
      ...(doseMatch?.[1]?.trim() ? { dose: doseMatch[1].trim() } : {}),
      ...(dateMatch?.[1]?.trim() ? { date: dateMatch[1].trim() } : {}),
    });
  }

  return items;
}

function normalizeVaccines(payload: unknown): VaccineItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    vaccine?: unknown;
    vaccines?: unknown;
    content?: unknown;
    output?: { vaccine?: unknown; vaccines?: unknown; content?: unknown };
    data?: { vaccine?: unknown; vaccines?: unknown; content?: unknown };
  };

  const vaccines =
    data.vaccine ??
    data.vaccines ??
    data.output?.vaccine ??
    data.output?.vaccines ??
    data.data?.vaccine ??
    data.data?.vaccines;

  if (Array.isArray(vaccines)) {
    return vaccines
      .map((entry): VaccineItem | null => {
        if (typeof entry === "string") {
          const name = entry.trim();
          return name ? { name } : null;
        }
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        const name =
          str(item.name) ??
          str(item.vaccine_name) ??
          str(item.vaccineName) ??
          str(item.vaccine) ??
          "";
        if (!name) return null;
        const dose =
          str(item.dose) ?? str(item.dose_number) ?? str(item.doseNumber);
        const date = str(item.date) ?? str(item.vaccinationDate);
        return {
          name,
          ...(dose ? { dose } : {}),
          ...(date ? { date } : {}),
        };
      })
      .filter((item): item is VaccineItem => item !== null);
  }

  const contentText =
    str(data.content) ?? str(data.output?.content) ?? str(data.data?.content);
  if (contentText) {
    return parseTextVaccines(contentText);
  }

  return [];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as VaccineRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const current_date = body.current_date?.trim() || todayMMDDYYYY();
    const messageWithDate = `${message}\nCURRENT DATE: ${current_date}`;

    const agentResponse = await hikigai.invokeAgent(
      "vaccine-agent",
      { message: messageWithDate },
      HIKIGAI_AGENT_TIMEOUT_MS
    );
    const vaccine = normalizeVaccines(agentResponse);
    logger.agentInvokeOk("vaccine-agent", {
      rawResponse: agentResponse,
      normalized: { vaccine },
    });
    return NextResponse.json({ vaccine }, { status: 200 });
  } catch (error) {
    logger.error("vaccine-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate vaccines";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
