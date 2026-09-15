import { NextResponse } from "next/server";
import { refreshEndUser } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      refresh_token?: string;
    };

    if (!body.refresh_token) {
      logAuthError("identity-refresh", "missing refresh token", {
        source: "server",
        origin: "next-api",
        event: "refresh_validation_failed",
        errorMessage: "Refresh token is required",
      });
      return NextResponse.json(
        authErrorBody("Refresh token is required", "next-api"),
        { status: 400 }
      );
    }

    const result = await refreshEndUser(body.refresh_token);
    logAuthOk("identity-refresh", "refresh route ok", {
      source: "server",
      origin: "next-api",
      event: "refresh_route_ok",
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token refresh failed";
    logAuthError(
      "identity-refresh",
      "refresh route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "refresh_route_failed",
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 401 });
  }
}
