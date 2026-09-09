import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";
import { normalizeReferrals } from "@/lib/referrals";

export const maxDuration = 300;

interface ReferralRequest {
  message?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ReferralRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentResponse = await hikigai.invokeAgent("referal-agent", { message }, HIKIGAI_AGENT_TIMEOUT_MS);
    const referrals = normalizeReferrals(agentResponse);
    logger.agentInvokeOk("referal-agent", {
      rawResponse: agentResponse,
      normalized: { referrals },
    });
    return NextResponse.json({ referrals }, { status: 200 });
  } catch (error) {
    logger.error("referal-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate referrals";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
