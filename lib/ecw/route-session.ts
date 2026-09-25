import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_MAX_AGE,
  cookieOptions,
  freshSession,
  loadEcwSettings,
  readSession,
  sessionCookies,
  type EcwSession,
} from "@/lib/ecw/smart";

/**
 * Runs `handler` with the request's eCW launch session, refreshing the access token
 * first when needed (and rewriting the session cookies on the response if it was).
 * Answers 401 when there is no session.
 */
export async function withEcwSession(
  request: NextRequest,
  handler: (session: EcwSession) => Promise<NextResponse>
): Promise<NextResponse> {
  let settings;
  try {
    settings = loadEcwSettings();
  } catch (error) {
    return NextResponse.json({ ok: false, error: { message: (error as Error).message } }, { status: 500 });
  }

  const stored = readSession(settings, request.cookies);
  if (!stored) {
    return NextResponse.json(
      { ok: false, connected: false, error: { message: "Not connected to eCW. Launch AI Scribe from eCW first." } },
      { status: 401 }
    );
  }

  const { session, refreshed } = await freshSession(settings, stored);
  const response = await handler(session);
  if (refreshed) {
    for (const [name, value] of sessionCookies(settings, session)) {
      response.cookies.set(name, value, cookieOptions(SESSION_COOKIE_MAX_AGE));
    }
  }
  return response;
}
