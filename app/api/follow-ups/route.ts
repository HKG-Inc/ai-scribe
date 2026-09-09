import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface FollowUpRequest {
  message?: string;
  current_date?: string;
}

function getCurrentDateMmDdYyyy() {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());
  return `${mm}/${dd}/${yyyy}`;
}

function normalizeFollowUps(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    follow_ups?: unknown;
    output?: {
      follow_ups?: unknown;
    };
    data?: {
      follow_ups?: unknown;
    };
  };

  const followUps = data.follow_ups ?? data.output?.follow_ups ?? data.data?.follow_ups;
  return Array.isArray(followUps) ? followUps : [];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as FollowUpRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const current_date = body.current_date?.trim() || getCurrentDateMmDdYyyy();
    const agentResponse = await hikigai.invokeAgent("follow-up-agent", {
      message,
      current_date,
    }, HIKIGAI_AGENT_TIMEOUT_MS);
    const follow_ups = normalizeFollowUps(agentResponse);
    logger.agentInvokeOk("follow-up-agent", {
      rawResponse: agentResponse,
      normalized: { follow_ups },
    });
    return NextResponse.json({ follow_ups }, { status: 200 });
  } catch (error) {
    logger.error("follow-up-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate follow-up data";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
