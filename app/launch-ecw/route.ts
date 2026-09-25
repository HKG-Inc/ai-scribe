import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import {
  EcwLaunchError,
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
  cookieOptions,
  discover,
  issAllowed,
  launchErrorPage,
  loadEcwSettings,
  pkcePair,
  seal,
  type PendingLaunch,
} from "@/lib/ecw/smart";

export const dynamic = "force-dynamic";

/** SMART EHR launch URL: eCW opens it with ?iss=…&launch=… from a patient chart. */
export async function GET(request: NextRequest) {
  const iss = request.nextUrl.searchParams.get("iss")?.replace(/\/+$/, "");
  const launch = request.nextUrl.searchParams.get("launch");

  if (!iss || !launch) {
    return launchErrorPage(
      "Launch AI Scribe from eCW",
      "This is the eCW EHR-launch address. eCW opens it with iss and launch parameters when you launch the app from a patient's chart; it was opened without them."
    );
  }

  try {
    const settings = loadEcwSettings();
    if (!issAllowed(iss, settings)) {
      logger.warn("ecw-launch", "rejected iss", { event: "ecw_launch_bad_iss", iss });
      return launchErrorPage("Unknown EHR server", `${iss} is not an allowed eCW FHIR server.`);
    }

    const endpoints = await discover(iss);
    const { verifier, challenge } = pkcePair();
    const pending: PendingLaunch = {
      state: randomBytes(32).toString("base64url"),
      verifier,
      iss,
      tokenUrl: endpoints.token,
      created: Date.now(),
    };

    const params = new URLSearchParams({
      response_type: "code",
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      launch,
      scope: settings.scopes,
      state: pending.state,
      aud: iss,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    logger.info("ecw-launch", "redirecting to eCW authorize", { event: "ecw_launch_started", iss });
    const response = NextResponse.redirect(`${endpoints.authorize}?${params.toString()}`);
    response.cookies.set(PENDING_COOKIE, seal(settings, pending), cookieOptions(PENDING_TTL_SECONDS));
    return response;
  } catch (error) {
    logger.error("ecw-launch", "launch failed", { event: "ecw_launch_failed", iss, ...errorFields(error) });
    const detail = error instanceof EcwLaunchError ? error.message : "Could not reach the eCW server.";
    return launchErrorPage("Could not start the eCW sign-in", detail, 502);
  }
}
