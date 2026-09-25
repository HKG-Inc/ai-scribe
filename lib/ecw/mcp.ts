/**
 * Client for the eCW MCP platform connector (ecw-mcp-platform on the Hikigai platform).
 *
 * The connector is stateless and authenticated with the Hikigai API key (X-API-Key).
 * It holds no eCW credentials for this app: every call carries the launch's FHIR base
 * (x-ecw-base-url) and the clinician's current access token (x-ecw-access-token),
 * taken from the server-side eCW session.
 */
const ECW_MCP_PLATFORM_URL =
  process.env.ECW_MCP_PLATFORM_URL || "https://ecw-mcp-platform-dad3cbe0.connectors.hikigaiplatform.io/mcp/";

export type EcwToolName =
  | "ecw_read_resource"
  | "ecw_search_resources"
  | "ecw_everything"
  | "ecw_next_page";

/** Tool envelope returned by ecw-mcp (see its README, "Response envelope"). */
export type EcwToolResult = {
  ok: boolean;
  operation?: string;
  status?: number | null;
  resource_type?: string;
  id?: string;
  resource?: Record<string, unknown>;
  bundle?: Record<string, unknown>;
  page?: Record<string, unknown>;
  issues?: unknown[];
  error?: { type?: string; message?: string; status?: number };
};

type JsonRpcResponse = { id?: number; result?: unknown; error?: { message?: string; code?: number } };

type EcwCredentials = { baseUrl: string; accessToken: string };

function parseBody(body: string): JsonRpcResponse {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("Empty MCP response");
  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    // text/event-stream: the last `data:` line carries the JSON-RPC response
    const data = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error("Unable to parse MCP response");
    return JSON.parse(data[data.length - 1]) as JsonRpcResponse;
  }
}

export async function callEcwTool(
  name: EcwToolName,
  args: Record<string, unknown>,
  creds: EcwCredentials
): Promise<EcwToolResult> {
  const apiKey = process.env.HIKIGAI_API_KEY;
  if (!apiKey) throw new Error("Missing HIKIGAI_API_KEY");

  const response = await fetch(ECW_MCP_PLATFORM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": apiKey,
      "x-ecw-base-url": creds.baseUrl,
      "x-ecw-access-token": creds.accessToken,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`eCW MCP request failed (${response.status}): ${text.slice(0, 300)}`);

  const parsed = parseBody(text);
  if (parsed.error) throw new Error(parsed.error.message || "eCW MCP error");

  const toolResult = parsed.result as {
    structuredContent?: EcwToolResult;
    content?: { type?: string; text?: string }[];
  };
  if (toolResult?.structuredContent) return toolResult.structuredContent;
  const toolText = toolResult?.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(toolText) as EcwToolResult;
  } catch {
    return { ok: false, error: { type: "tool_error", message: toolText || "eCW MCP tool call failed" } };
  }
}
