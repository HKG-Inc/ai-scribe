import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface VisitNotesRequest {
  message?: string;
  speciality?: string;
}

function extractVisitNotes(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    visit_notes?: unknown;
    output?: {
      visit_notes?: unknown;
    };
    data?: {
      visit_notes?: unknown;
    };
  };

  const notes = data.visit_notes ?? data.output?.visit_notes ?? data.data?.visit_notes;

  if (Array.isArray(notes)) {
    return notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0);
  }

  if (typeof notes === "string" && notes.trim().length > 0) {
    return [notes];
  }

  return [];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as VisitNotesRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const input = body.speciality?.trim()
      ? { message, speciality: body.speciality.trim() }
      : { message, speciality: "general" };

    const agentResponse = await hikigai.invokeAgent("visit-notes-agent", input, HIKIGAI_AGENT_TIMEOUT_MS);
    const visitNotes = extractVisitNotes(agentResponse);
    logger.agentInvokeOk("visit-notes-agent", {
      rawResponse: agentResponse,
      normalized: { visit_notes: visitNotes },
    });

    return NextResponse.json({ visit_notes: visitNotes }, { status: 200 });
  } catch (error) {
    logger.error("visit-notes-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate visit notes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
