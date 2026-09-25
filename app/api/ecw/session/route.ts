import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE,
  CONTEXT_COOKIE,
  REFRESH_COOKIE,
  cookieOptions,
  loadEcwSettings,
  readSession,
} from "@/lib/ecw/smart";

export const dynamic = "force-dynamic";

/** Current eCW launch context for the browser (patient, encounter, user). Never returns tokens. */
export async function GET(request: NextRequest) {
  let settings;
  try {
    settings = loadEcwSettings();
  } catch {
    return NextResponse.json({ connected: false, configured: false });
  }
  const session = readSession(settings, request.cookies);
  if (!session) return NextResponse.json({ connected: false, configured: true });

  const { iss, patient, encounter, fhirUser, userName, scope, expiresAt } = session.context;
  return NextResponse.json({
    connected: true,
    configured: true,
    iss,
    patient,
    encounter,
    fhirUser,
    userName,
    scope,
    expiresAt,
    canRefresh: Boolean(session.refreshToken),
  });
}

/** Disconnect from eCW. */
export async function DELETE() {
  const response = NextResponse.json({ connected: false });
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, CONTEXT_COOKIE]) response.cookies.set(name, "", cookieOptions(0));
  return response;
}
