import { NextResponse, type NextRequest } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import { callEcwTool } from "@/lib/ecw/mcp";
import { withEcwSession } from "@/lib/ecw/route-session";
import { CHART_SECTIONS, bundleRows, isChartSection } from "@/lib/ecw/chart";

export const dynamic = "force-dynamic";

/**
 * One chart section for the launch patient, through the eCW MCP connector:
 *   GET /api/ecw/patient-data/problems            -> ecw_search_resources(Condition, patient_id=<launch patient>)
 *   GET /api/ecw/patient-data/problems?page=<url> -> ecw_next_page(<url>)   ("Load more")
 * The patient always comes from the server-side launch session, never from the browser.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ section: string }> }) {
  const { section } = await ctx.params;
  if (!isChartSection(section)) {
    return NextResponse.json({ ok: false, error: { message: `Unknown section ${section}` } }, { status: 404 });
  }
  const spec = CHART_SECTIONS[section];
  const pageUrl = request.nextUrl.searchParams.get("page");

  try {
    return await withEcwSession(request, async (session) => {
      const { iss, patient } = session.context;
      if (!patient) {
        return NextResponse.json(
          { ok: false, error: { message: "This eCW launch has no patient in context." } },
          { status: 400 }
        );
      }
      // Paging links must stay on this launch's FHIR server.
      if (pageUrl && !pageUrl.startsWith(`${iss}/`) && !pageUrl.startsWith(`${iss}?`)) {
        return NextResponse.json({ ok: false, error: { message: "Invalid page link" } }, { status: 400 });
      }

      const creds = { baseUrl: iss, accessToken: session.accessToken };
      const result = pageUrl
        ? await callEcwTool("ecw_next_page", { page_url: pageUrl }, creds)
        : await callEcwTool(
            "ecw_search_resources",
            { resource_type: spec.resourceType, patient_id: patient, params: "params" in spec ? spec.params : {} },
            creds
          );

      if (!result.ok) {
        logger.warn("ecw-chart", "eCW chart section failed", {
          event: "ecw_chart_failed",
          section,
          status: result.status,
          error: result.error,
        });
        const status = result.status && result.status >= 400 ? result.status : 502;
        const message =
          result.status === 403
            ? `eCW denied access to ${spec.resourceType}. Add patient/${spec.resourceType}.read to ECW_LAUNCH_SCOPES (and select it for the app in the eCW portal), then launch again.`
            : (result.error?.message ?? "eCW request failed");
        return NextResponse.json({ ok: false, status: result.status, error: { message } }, { status });
      }

      const nextUrl = (result.page?.next_url as string | null | undefined) ?? null;
      return NextResponse.json({
        ok: true,
        section,
        rows: bundleRows(result.bundle, spec.resourceType),
        total: (result.page?.total as number | undefined) ?? null,
        nextPage: nextUrl,
      });
    });
  } catch (error) {
    logger.error("ecw-chart", "eCW chart section error", { event: "ecw_chart_error", section, ...errorFields(error) });
    return NextResponse.json({ ok: false, error: { message: (error as Error).message } }, { status: 502 });
  }
}
