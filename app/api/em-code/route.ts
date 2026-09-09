import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface EmCodeRequest {
  message?: string;
}

function normalizeEmCode(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { em_code: "", description: "" };
  }

  const data = payload as {
    em_code?: unknown;
    description?: unknown;
    output?: {
      em_code?: unknown;
      description?: unknown;
    };
    data?: {
      em_code?: unknown;
      description?: unknown;
    };
  };

  const container = data.output || data.data || data;

  return {
    em_code: typeof container.em_code === "string" ? container.em_code : "",
    description: typeof container.description === "string" ? container.description : "",
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as EmCodeRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentResponse = await hikigai.invokeAgent("em-code-agent", { message }, HIKIGAI_AGENT_TIMEOUT_MS);
    const normalized = normalizeEmCode(agentResponse);
    logger.agentInvokeOk("em-code-agent", {
      rawResponse: agentResponse,
      normalized,
    });
    return NextResponse.json(normalized, { status: 200 });
  } catch (error) {
    logger.error("em-code-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate E&M code";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
