import { NextResponse } from "next/server";
import { forgotPassword } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as { email?: string };
    email = body.email?.trim() || "";

    if (!body.email) {
      logAuthError("identity-forgot-password", "missing email", {
        source: "server",
        origin: "next-api",
        event: "forgot_password_validation_failed",
        errorMessage: "Email is required",
      });
      return NextResponse.json(authErrorBody("Email is required", "next-api"), {
        status: 400,
      });
    }

    const result = await forgotPassword(body.email);
    logAuthOk("identity-forgot-password", "forgot-password route ok", {
      source: "server",
      origin: "next-api",
      event: "forgot_password_route_ok",
      email: body.email,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to request password reset";
    logAuthError(
      "identity-forgot-password",
      "forgot-password route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "forgot_password_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
