const BIGQUERY_MCP_SERVER_URL =
  process.env.BIGQUERY_MCP_SERVER_URL ||
  "https://bigquery-mcp-server-dad3cbe0.connectors.hikigaiplatform.io/mcp/";

export type DiagnosisFeedbackType =
  | "soap"
  | "visit_notes"
  | "labtest"
  | "followup"
  | "procedure"
  | "medication"
  | "vaccine"
  | "referral"
  | "icd_codes"
  | "em_codes"
  | "cpt2_codes";

export interface WriteDiagnosisFeedbackInput {
  visit_id: string;
  session_id: string;
  feedback_type: DiagnosisFeedbackType;
  rating: 0 | 1;
  notes?: string;
  response?: string[];
  doctor_id?: string;
  doctor_name?: string;
  patient_id?: string;
}

export interface GetSubscriptionMinutesLeftInput {
  doctor_id: string;
  doctor_name?: string;
}

export interface DeductSubscriptionMinutesInput {
  doctor_id: string;
  consumed_minutes: number;
  doctor_name?: string;
}

interface JsonRpcError {
  message?: string;
  code?: number;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: JsonRpcError;
}

interface ToolCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function getMcpEndpoint(): string {
  const apiKey = process.env.HIKIGAI_API_KEY;
  const projectId = process.env.HIKIGAI_PROJECT_ID;

  if (!apiKey) {
    throw new Error("Missing HIKIGAI_API_KEY");
  }

  if (!projectId) {
    throw new Error("Missing HIKIGAI_PROJECT_ID");
  }

  const params = new URLSearchParams({
    apiKey,
    projectId,
  });

  return `${BIGQUERY_MCP_SERVER_URL}?${params.toString()}`;
}

function parseMcpResponseBody(body: string): JsonRpcResponse | JsonRpcResponse[] {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new Error("Empty MCP response");
  }

  try {
    return JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
  } catch {
    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    if (dataLines.length === 0) {
      throw new Error("Unable to parse MCP response");
    }

    return JSON.parse(dataLines[dataLines.length - 1]) as JsonRpcResponse;
  }
}

function extractJsonRpcResponse(
  parsed: JsonRpcResponse | JsonRpcResponse[]
): JsonRpcResponse {
  if (Array.isArray(parsed)) {
    const response = [...parsed].reverse().find((item) => item.result !== undefined || item.error);
    if (!response) {
      throw new Error("No MCP response payload found");
    }
    return response;
  }

  return parsed;
}

async function sendMcpMessage(
  message: Record<string, unknown>,
  sessionId?: string
): Promise<{ result: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(getMcpEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  const responseSessionId = response.headers.get("mcp-session-id") || sessionId || undefined;
  const text = await response.text();

  if (!response.ok) {
    let detail = text;
    try {
      const errorJson = JSON.parse(text) as { detail?: string; error?: string };
      detail = errorJson.detail || errorJson.error || text;
    } catch {
      // Keep raw response text.
    }
    throw new Error(`MCP request failed (${response.status}): ${detail}`);
  }

  // MCP notifications (e.g. notifications/initialized) return 202 with no body.
  if (!text.trim()) {
    return {
      result: undefined,
      sessionId: responseSessionId,
    };
  }

  const parsed = extractJsonRpcResponse(parseMcpResponseBody(text));
  if (parsed.error) {
    throw new Error(parsed.error.message || "MCP error");
  }

  return {
    result: parsed.result,
    sessionId: responseSessionId,
  };
}

async function initializeMcpSession(): Promise<string | undefined> {
  const { sessionId } = await sendMcpMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "ai-scribe",
        version: "1.0.0",
      },
    },
  });

  await sendMcpMessage(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    sessionId
  );

  return sessionId;
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const toolResult = result as ToolCallResult;

  if (toolResult?.isError) {
    throw new Error(toolResult.content?.[0]?.text || "MCP tool call failed");
  }

  const text = toolResult?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : { success: true, result };
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { success: true, raw: text };
  }
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const sessionId = await initializeMcpSession();
  const { result } = await sendMcpMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    },
    sessionId
  );

  return parseToolResult(result);
}

export async function writeDiagnosisFeedback(
  input: WriteDiagnosisFeedbackInput
): Promise<Record<string, unknown>> {
  if (input.rating !== 0 && input.rating !== 1) {
    throw new Error("rating must be 0 or 1");
  }

  return callMcpTool("write_diagnosis_feedback", { ...input });
}

export async function getSubscriptionMinutesLeft(
  input: GetSubscriptionMinutesLeftInput
): Promise<Record<string, unknown>> {
  const doctorId = input.doctor_id.trim();
  if (!doctorId) {
    throw new Error("doctor_id is required");
  }

  return callMcpTool("get_subscription_minutes_left", {
    doctor_id: doctorId,
    doctor_name: input.doctor_name?.trim() || "",
  });
}

export async function deductSubscriptionMinutes(
  input: DeductSubscriptionMinutesInput
): Promise<Record<string, unknown>> {
  const doctorId = input.doctor_id.trim();
  if (!doctorId) {
    throw new Error("doctor_id is required");
  }

  if (!Number.isFinite(input.consumed_minutes) || input.consumed_minutes < 0) {
    throw new Error("consumed_minutes must be a non-negative number");
  }

  return callMcpTool("deduct_subscription_minutes", {
    doctor_id: doctorId,
    consumed_minutes: input.consumed_minutes,
    doctor_name: input.doctor_name?.trim() || "",
  });
}
