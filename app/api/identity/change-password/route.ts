import { NextResponse } from "next/server";
import { changePassword } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      access_token?: string;
      current_password?: string;
      new_password?: string;
    };

    if (!body.access_token || !body.current_password || !body.new_password) {
      logAuthError("identity-change-password", "missing fields", {
        source: "server",
        origin: "next-api",
        event: "change_password_validation_failed",
        errorMessage: "Access token, current password, and new password are required",
      });
      return NextResponse.json(
        authErrorBody(
          "Access token, current password, and new password are required",
          "next-api"
        ),
        { status: 400 }
      );
    }

    const result = await changePassword({
      access_token: body.access_token,
      current_password: body.current_password,
      new_password: body.new_password,
    });
    logAuthOk("identity-change-password", "change-password route ok", {
      source: "server",
      origin: "next-api",
      event: "change_password_route_ok",
    });
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to change password";
    logAuthError(
      "identity-change-password",
      "change-password route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "change_password_route_failed",
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
