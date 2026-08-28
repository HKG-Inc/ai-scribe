import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import {
  buildQuestionnaireCombinedMessage,
  extractAgentOutput,
  formatQuestionnaireVisitNotesText,
  mergeQuestionnaireAgentOutputs,
  type QuestionnaireQAItem,
} from "@/lib/questionnaire-visit-notes";

export const maxDuration = 300;

interface VisitNotesRequest {
  message?: string;
  speciality?: string;
  questionnaire_responses?: QuestionnaireQAItem[];
  visit_date?: string;
}

function normalizeQuestionnaireResponses(
  value: unknown
): QuestionnaireQAItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const question_text =
        typeof row.question_text === "string"
          ? row.question_text
          : typeof row.questionEn === "string"
            ? row.questionEn
            : "";
      const answer_text =
        typeof row.answer_text === "string"
          ? row.answer_text
          : typeof row.responseEn === "string"
            ? row.responseEn
            : typeof row.responseTranslated === "object" &&
                row.responseTranslated &&
                typeof (row.responseTranslated as { english_translation?: unknown })
                  .english_translation === "string"
              ? (
                  row.responseTranslated as {
                    english_translation: string;
                  }
                ).english_translation
              : "";

      if (!question_text.trim() && !answer_text.trim()) return null;
      return { question_text, answer_text };
    })
    .filter((item): item is QuestionnaireQAItem => item !== null);
}

function parseVisitDate(value: unknown): Date {
  if (typeof value === "string" && value.trim()) {
    // Accept MM/DD/YY from client; otherwise fall back to Date parse / today.
    const mmDdYy = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (mmDdYy) {
      const month = Number(mmDdYy[1]);
      const day = Number(mmDdYy[2]);
      let year = Number(mmDdYy[3]);
      if (year < 100) year += 2000;
      const parsed = new Date(year, month - 1, day);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as VisitNotesRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const questionnaireResponses = normalizeQuestionnaireResponses(
      body.questionnaire_responses
    );
    const visitDate = parseVisitDate(body.visit_date);
    const combinedMessage = buildQuestionnaireCombinedMessage(
      message,
      questionnaireResponses,
      visitDate
    );

    const input = { message: combinedMessage };

    const [ccRaw, mskRaw, tbiRaw, medRaw, funcRaw] = await Promise.all([
      hikigai.invokeAgent(
        "questionnaire-chief-complaint-agent",
        input,
        HIKIGAI_AGENT_TIMEOUT_MS
      ),
      hikigai.invokeAgent(
        "questionnaire-msk-agent",
        input,
        HIKIGAI_AGENT_TIMEOUT_MS
      ),
      hikigai.invokeAgent(
        "questionnaire-tbi-agent",
        input,
        HIKIGAI_AGENT_TIMEOUT_MS
      ),
      hikigai.invokeAgent(
        "questionnaire-medical-agent",
        input,
        HIKIGAI_AGENT_TIMEOUT_MS
      ),
      hikigai.invokeAgent(
        "questionnaire-functionality-agent",
        input,
        HIKIGAI_AGENT_TIMEOUT_MS
      ),
    ]);

    console.log(
      "\n [questionnaire-visit-notes] raw invoke outputs:",
      JSON.stringify({
        chief_complaint: ccRaw,
        msk: mskRaw,
        tbi: tbiRaw,
        medical: medRaw,
        functionality: funcRaw,
      })
    );

    const merged = mergeQuestionnaireAgentOutputs({
      chiefComplaint: extractAgentOutput(ccRaw),
      msk: extractAgentOutput(mskRaw),
      tbi: extractAgentOutput(tbiRaw),
      medical: extractAgentOutput(medRaw),
      functionality: extractAgentOutput(funcRaw),
    });

    const displayText = formatQuestionnaireVisitNotesText(merged.visit_notes);

    return NextResponse.json(
      {
        ...merged,
        // Backward-compatible flat array for existing report UI / PDF.
        visit_notes_text: displayText ? [displayText] : [],
      },
      { status: 200 }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to generate visit notes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
