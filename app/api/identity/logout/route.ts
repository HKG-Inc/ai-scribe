import { NextResponse } from "next/server";
import { logoutEndUser } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as {
      email?: string;
    };
    email = body.email?.trim() || "";

    if (!body.email) {
      logAuthError("identity-logout", "missing email", {
        source: "server",
        origin: "next-api",
        event: "logout_validation_failed",
        errorMessage: "Email is required",
      });
      return NextResponse.json(authErrorBody("Email is required", "next-api"), {
        status: 400,
      });
    }

    const result = await logoutEndUser(body.email);
    logAuthOk("identity-logout", "logout route ok", {
      source: "server",
      origin: "next-api",
      event: "logout_route_ok",
      email: body.email,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Logout failed";
    logAuthError(
      "identity-logout",
      "logout route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "logout_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
