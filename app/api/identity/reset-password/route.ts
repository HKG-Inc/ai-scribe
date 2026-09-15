import { NextResponse } from "next/server";
import { resetPassword } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as {
      email?: string;
      code?: string;
      new_password?: string;
    };
    email = body.email?.trim() || "";

    if (!body.email || !body.code || !body.new_password) {
      logAuthError("identity-reset-password", "missing fields", {
        source: "server",
        origin: "next-api",
        event: "reset_password_validation_failed",
        email: email || undefined,
        errorMessage: "Email, code, and new password are required",
      });
      return NextResponse.json(
        authErrorBody("Email, code, and new password are required", "next-api"),
        { status: 400 }
      );
    }

    const result = await resetPassword({
      email: body.email,
      code: body.code,
      new_password: body.new_password,
    });
    logAuthOk("identity-reset-password", "reset-password route ok", {
      source: "server",
      origin: "next-api",
      event: "reset_password_route_ok",
      email: body.email,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reset password";
    logAuthError(
      "identity-reset-password",
      "reset-password route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "reset_password_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
