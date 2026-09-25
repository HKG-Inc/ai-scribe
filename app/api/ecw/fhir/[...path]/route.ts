import { NextResponse, type NextRequest } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import { callEcwTool, type EcwToolName } from "@/lib/ecw/mcp";
import { withEcwSession } from "@/lib/ecw/route-session";

export const dynamic = "force-dynamic";

const SEGMENT = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * Read-only eCW FHIR access for the launched session, through the eCW MCP connector:
 *   GET /api/ecw/fhir/Patient/<id>                -> ecw_read_resource
 *   GET /api/ecw/fhir/Condition?patient=<id>      -> ecw_search_resources
 *   GET /api/ecw/fhir/Patient/<id>/$everything    -> ecw_everything
 * Responds with the connector's envelope ({ ok, status, resource | bundle, error, … }).
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const [resourceType, resourceId, operation] = path;
  const valid =
    path.length >= 1 &&
    path.length <= 3 &&
    SEGMENT.test(resourceType) &&
    (resourceId === undefined || SEGMENT.test(resourceId)) &&
    (operation === undefined || operation === "$everything");
  if (!valid) return NextResponse.json({ ok: false, error: { message: "Invalid FHIR path" } }, { status: 400 });

  const params = Object.fromEntries(request.nextUrl.searchParams);
  let tool: EcwToolName;
  let args: Record<string, unknown>;
  if (operation) {
    tool = "ecw_everything";
    args = { resource_type: resourceType, resource_id: resourceId, params };
  } else if (resourceId) {
    tool = "ecw_read_resource";
    args = { resource_type: resourceType, resource_id: resourceId };
  } else {
    tool = "ecw_search_resources";
    args = { resource_type: resourceType, params };
  }

  try {
    return await withEcwSession(request, async (session) => {
      const result = await callEcwTool(tool, args, {
        baseUrl: session.context.iss,
        accessToken: session.accessToken,
      });
      if (!result.ok) {
        logger.warn("ecw-fhir", "eCW MCP tool returned an error", {
          event: "ecw_mcp_tool_failed",
          tool,
          resource: resourceType,
          status: result.status,
          error: result.error,
        });
      }
      const status = result.ok ? 200 : result.status && result.status >= 400 ? result.status : 502;
      return NextResponse.json(result, { status });
    });
  } catch (error) {
    logger.error("ecw-fhir", "eCW MCP call failed", { event: "ecw_mcp_error", tool, resource: resourceType, ...errorFields(error) });
    return NextResponse.json({ ok: false, error: { message: (error as Error).message } }, { status: 502 });
  }
}
