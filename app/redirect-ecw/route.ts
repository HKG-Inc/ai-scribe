import { NextResponse, type NextRequest } from "next/server";
import { logger, errorFields } from "@/lib/logger";
import {
  EcwLaunchError,
  PENDING_COOKIE,
  PENDING_TTL_SECONDS,
  SESSION_COOKIE_MAX_AGE,
  appUrl,
  contextFromToken,
  cookieOptions,
  launchErrorPage,
  loadEcwSettings,
  sessionCookies,
  tokenRequest,
  unseal,
  type PendingLaunch,
} from "@/lib/ecw/smart";

export const dynamic = "force-dynamic";

/** SMART redirect URI: eCW sends the clinician back here with ?code=…&state=…. */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;

  const oauthError = q.get("error");
  if (oauthError) {
    logger.warn("ecw-launch", "eCW returned an OAuth error", {
      event: "ecw_callback_oauth_error",
      oauthError,
      description: q.get("error_description"),
    });
    const hint =
      oauthError === "invalid_scope"
        ? "eCW rejected the requested scopes. Set ECW_LAUNCH_SCOPES to scopes enabled for this app in the eCW portal."
        : q.get("error_description") || oauthError;
    return launchErrorPage("eCW did not authorize AI Scribe", hint);
  }

  try {
    const settings = loadEcwSettings();
    const pending = unseal<PendingLaunch>(settings, request.cookies.get(PENDING_COOKIE)?.value);
    const code = q.get("code");
    if (!pending || !code || q.get("state") !== pending.state || Date.now() - pending.created > PENDING_TTL_SECONDS * 1000) {
      return launchErrorPage("Sign-in expired", "The eCW sign-in state is missing, expired or does not match.");
    }

    const body = await tokenRequest(settings, pending.tokenUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: pending.verifier,
    });
    const context = contextFromToken(pending, body);

    logger.info("ecw-launch", "eCW launch completed", {
      event: "ecw_launch_completed",
      iss: context.iss,
      hasPatient: Boolean(context.patient),
      hasEncounter: Boolean(context.encounter),
      hasFhirUser: Boolean(context.fhirUser),
      hasRefreshToken: Boolean(body.refresh_token),
      grantedScope: context.scope,
    });

    // /login forwards to /recording when the clinician is already signed in to AI Scribe.
    const target = appUrl(settings, "/login");
    target.searchParams.set("ecw", "connected");
    const response = NextResponse.redirect(target);
    response.cookies.set(PENDING_COOKIE, "", cookieOptions(0));
    const session = { accessToken: body.access_token, refreshToken: body.refresh_token ?? "", context };
    for (const [name, value] of sessionCookies(settings, session)) {
      response.cookies.set(name, value, cookieOptions(SESSION_COOKIE_MAX_AGE));
    }
    return response;
  } catch (error) {
    logger.error("ecw-launch", "callback failed", { event: "ecw_callback_failed", ...errorFields(error) });
    const detail = error instanceof EcwLaunchError ? error.message : "Could not complete the eCW sign-in.";
    return launchErrorPage("Could not complete the eCW sign-in", detail, 502);
  }
}
