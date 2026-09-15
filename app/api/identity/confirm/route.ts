import { NextResponse } from "next/server";
import { confirmEndUser } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as {
      email?: string;
      code?: string;
    };
    email = body.email?.trim() || "";

    if (!body.email || !body.code) {
      logAuthError("identity-confirm", "missing fields", {
        source: "server",
        origin: "next-api",
        event: "confirm_validation_failed",
        email: email || undefined,
        errorMessage: "Email and confirmation code are required",
      });
      return NextResponse.json(
        authErrorBody("Email and confirmation code are required", "next-api"),
        { status: 400 }
      );
    }

    const result = await confirmEndUser({
      email: body.email,
      code: body.code,
    });

    logAuthOk("identity-confirm", "confirm route ok", {
      source: "server",
      origin: "next-api",
      event: "confirm_route_ok",
      email: body.email,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Confirmation failed";
    logAuthError(
      "identity-confirm",
      "confirm route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "confirm_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
