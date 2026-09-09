import { NextResponse } from "next/server";
import { HIKIGAI_AGENT_TIMEOUT_MS, hikigai } from "@/lib/hikigai";
import { errorFields, logger } from "@/lib/logger";

export const maxDuration = 300;

interface Icd10Request {
  message?: string;
}

type IcdCodeItem = {
  icd_10_code: string;
  name: string;
};

function normalizeIcdCodes(payload: unknown): IcdCodeItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const data = payload as {
    icd_codes?: unknown;
    output?: {
      icd_codes?: unknown;
    };
    data?: {
      icd_codes?: unknown;
    };
  };

  const icdCodes = data.icd_codes ?? data.output?.icd_codes ?? data.data?.icd_codes;

  if (!Array.isArray(icdCodes)) {
    return [];
  }

  return icdCodes
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const item = entry as {
        icd_10_code?: unknown;
        name?: unknown;
      };

      const icd_10_code = typeof item.icd_10_code === "string" ? item.icd_10_code : "";
      const name = typeof item.name === "string" ? item.name : "";

      if (!icd_10_code || !name) {
        return null;
      }

      return {
        icd_10_code,
        name,
      };
    })
    .filter((item): item is IcdCodeItem => item !== null);
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Icd10Request;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const agentResponse = await hikigai.invokeAgent("icd-10-code-agent", { message }, HIKIGAI_AGENT_TIMEOUT_MS);
    const icd_codes = normalizeIcdCodes(agentResponse);
    logger.agentInvokeOk("icd-10-code-agent", {
      rawResponse: agentResponse,
      normalized: { icd_codes },
    });
    return NextResponse.json({ icd_codes }, { status: 200 });
  } catch (error) {
    logger.error("icd-10-code-agent", "route failed", errorFields(error));
    const message = error instanceof Error ? error.message : "Failed to generate ICD-10 codes";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
