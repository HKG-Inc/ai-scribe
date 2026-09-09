import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  fetchStorageQuestion,
  isValidStorageLocale,
  isValidStorageQuestionId,
} from "@/lib/questionnaire/storage";

export const runtime = "nodejs";

/**
 * GET /api/questionnaire/storage/question?locale=te-IN&question=q1
 *
 * Returns pre-stored translated question text + a time-limited WAV signed URL.
 * Used as the primary play path; the live questionnaire-agent is the fallback.
 */
export async function GET(request: NextRequest) {
  const locale = request.nextUrl.searchParams.get("locale")?.trim() || "";
  const question = request.nextUrl.searchParams.get("question")?.trim() || "";

  if (!locale || !question) {
    return NextResponse.json(
      { error: "locale and question query params are required" },
      { status: 400 }
    );
  }

  if (!isValidStorageLocale(locale)) {
    return NextResponse.json({ error: `Unsupported locale: ${locale}` }, { status: 400 });
  }

  if (!isValidStorageQuestionId(question)) {
    return NextResponse.json(
      { error: `Unsupported question id: ${question}` },
      { status: 400 }
    );
  }

  try {
    const asset = await fetchStorageQuestion(locale, question);
    return NextResponse.json({
      locale: asset.locale,
      questionId: asset.questionId,
      translatedText: asset.translatedText,
      audioUrl: asset.audioUrl,
      expiresIn: asset.expiresIn,
      source: "storage",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch storage question";
    logger.warn("questionnaire/storage/question", "fetch failed", { error: message });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
