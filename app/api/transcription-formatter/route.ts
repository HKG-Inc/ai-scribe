import { NextRequest, NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";

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
    console.log("[transcription-formatter] raw invoke output:", JSON.stringify(result));

    const output = result.output as { transcription?: string; transcript?: unknown } | undefined;
    const formattedTranscription = output?.transcription || result.content || message;
    const structuredTranscript = output?.transcript ?? null;

    return NextResponse.json({
      transcription: formattedTranscription,
      transcript: structuredTranscript,
      raw: result,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[transcription-formatter] Error:", errorMessage);
    return NextResponse.json(
      { error: `Internal server error: ${errorMessage}` },
      { status: 500 }
    );
  }
}
