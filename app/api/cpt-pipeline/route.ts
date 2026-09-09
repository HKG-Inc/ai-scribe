import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface CptPipelineRequest {
  message?: string;
}

type ProcedureItem = {
  procedure_name: string;
  procedure_type: string;
  clinical_context: string;
  order_status: string;
};

type CptCodeItem = {
  name: string;
  cpt_code: string;
  rank?: number;
  confidence?: string;
};

function normalizeProcedures(payload: unknown): ProcedureItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    procedures?: unknown;
    output?: { procedures?: unknown };
    data?: { procedures?: unknown };
  };

  const procedures = data.procedures ?? data.output?.procedures ?? data.data?.procedures;

  if (!Array.isArray(procedures)) {
    return [];
  }

  return procedures
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const procedure_name = typeof item.procedure_name === "string" ? item.procedure_name : "";
      if (!procedure_name) return null;
      return {
        procedure_name,
        procedure_type: typeof item.procedure_type === "string" ? item.procedure_type : "",
        clinical_context: typeof item.clinical_context === "string" ? item.clinical_context : "",
        order_status: typeof item.order_status === "string" ? item.order_status : "",
      };
    })
    .filter((item): item is ProcedureItem => item !== null);
}

function normalizeCptCodes(payload: unknown): CptCodeItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    cpt_codes?: unknown;
    output?: { cpt_codes?: unknown };
    data?: { cpt_codes?: unknown };
  };

  const cptCodes = data.cpt_codes ?? data.output?.cpt_codes ?? data.data?.cpt_codes;

  if (!Array.isArray(cptCodes)) {
    return [];
  }

  return cptCodes
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const cpt_code = typeof item.cpt_code === "string" ? item.cpt_code : "";
      const name = typeof item.name === "string" ? item.name : "";

      if (!cpt_code || !name) {
        return null;
      }

      const normalized: CptCodeItem = {
        cpt_code,
        name,
      };

      if (typeof item.rank === "number") {
        normalized.rank = item.rank;
      }
      if (typeof item.confidence === "string") {
        normalized.confidence = item.confidence;
      }

      return normalized;
    })
    .filter((item): item is CptCodeItem => item !== null);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CptPipelineRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentResponse = await hikigai.invokeAgent("cpt-coding-pipeline", { message }, HIKIGAI_AGENT_TIMEOUT_MS);
    const procedures = normalizeProcedures(agentResponse);
    const cpt_codes = normalizeCptCodes(agentResponse);
    logger.agentInvokeOk("cpt-coding-pipeline", {
      rawResponse: agentResponse,
      normalized: { procedures, cpt_codes },
    });
    return NextResponse.json({ procedures, cpt_codes }, { status: 200 });
  } catch (error) {
    logger.error("cpt-coding-pipeline", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate CPT pipeline";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
