import { NextRequest, NextResponse } from "next/server";
import { fetchCannedQuestion } from "@/lib/questionnaire/gcs";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const language = request.nextUrl.searchParams.get("language")?.trim();
  const questionId = request.nextUrl.searchParams.get("question_id")?.trim();

  if (!language || !questionId) {
    return NextResponse.json(
      { available: false, error: "language and question_id are required" },
      { status: 400 }
    );
  }

  const result = await fetchCannedQuestion(language, questionId);
  return NextResponse.json(result);
}
