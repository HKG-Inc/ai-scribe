import { NextRequest, NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const { message } = (await request.json()) as { message?: string };

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Message is required and must be a string" },
        { status: 400 }
      );
    }

    const result = await hikigai.invokeAgent("transcription-agent", {
      transcription: message,
    }, HIKIGAI_AGENT_TIMEOUT_MS);
    logger.agentInvokeOk("transcription-agent", { rawResponse: result });

    const output = result.output as { transcription?: string; transcript?: unknown } | undefined;
    const formattedTranscription = output?.transcription || result.content || message;
    const structuredTranscript = output?.transcript ?? null;

    return NextResponse.json({
      transcription: formattedTranscription,
      transcript: structuredTranscript,
      raw: result,
    });
  } catch (error) {
    logger.error("transcription-agent", "route failed", errorFields(error));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Internal server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}
