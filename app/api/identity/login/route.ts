import { NextResponse } from "next/server";
import { loginEndUser } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };
    email = body.email?.trim() || "";

    if (!body.email || !body.password) {
      logAuthError("identity-login", "missing credentials", {
        source: "server",
        origin: "next-api",
        event: "login_validation_failed",
        email: email || undefined,
        errorMessage: "Email and password are required",
      });
      return NextResponse.json(
        authErrorBody("Email and password are required", "next-api"),
        { status: 400 }
      );
    }

    const result = await loginEndUser({
      email: body.email,
      password: body.password,
    });

    logAuthOk("identity-login", "login route ok", {
      source: "server",
      origin: "next-api",
      event: "login_route_ok",
      email: body.email,
      loginStatus: result.status,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign in failed";
    logAuthError(
      "identity-login",
      "login route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "login_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 401 });
  }
}
