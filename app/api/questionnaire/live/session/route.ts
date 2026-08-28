import { NextRequest, NextResponse } from "next/server";
import { HIKIGAI_BACKEND_URL_DEFAULT, HikigaiClient } from "@/lib/hikigai";
import {
  QUESTIONNAIRE_PLAY_AGENT,
  QUESTIONNAIRE_REPLY_AGENT,
} from "@/lib/questionnaire/constants";

export const runtime = "nodejs";

const ALLOWED_AGENTS = new Set([QUESTIONNAIRE_PLAY_AGENT, QUESTIONNAIRE_REPLY_AGENT]);

export async function POST(request: NextRequest) {
  const apiKey = process.env.HIKIGAI_API_KEY || "";
  const projectId = process.env.HIKIGAI_PROJECT_ID || "";
  const baseUrl =
    process.env.HIKIGAI_BASE_URL ||
    process.env.HIKIGAI_PLATFORM_URL ||
    process.env.HIKIGAI_BACKEND_URL ||
    HIKIGAI_BACKEND_URL_DEFAULT;

  if (!apiKey || !projectId) {
    return NextResponse.json(
      { error: "Missing HIKIGAI_API_KEY or HIKIGAI_PROJECT_ID in environment" },
      { status: 500 }
    );
  }

  let body: { agent_slug?: string; session_id?: string; user_id?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const agentSlug = body.agent_slug?.trim() || QUESTIONNAIRE_PLAY_AGENT;
  if (!ALLOWED_AGENTS.has(agentSlug)) {
    return NextResponse.json({ error: "Invalid agent_slug" }, { status: 400 });
  }

  const sessionId = body.session_id || crypto.randomUUID();
  const userId = body.user_id || "ai-scribe-questionnaire";

  try {
    const client = new HikigaiClient(apiKey, projectId, baseUrl);
    const { token } = await client.ensureAuthToken();

    const response = await fetch(
      `${baseUrl}/api/v1/agents/${encodeURIComponent(agentSlug)}/live/session`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-Project-ID": projectId,
        },
        body: JSON.stringify({
          session_id: sessionId,
          user_id: userId,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Live session mint failed (${response.status}): ${errorText}` },
        { status: response.status }
      );
    }

    const sessionInfo = await response.json();
    return NextResponse.json({
      ...sessionInfo,
      session_id: sessionInfo.session_id || sessionId,
      agent_slug: agentSlug,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to mint live session";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
