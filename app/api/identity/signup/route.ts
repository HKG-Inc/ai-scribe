import { NextResponse } from "next/server";
import { signupEndUser } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";
import { getPersonNameError } from "@/lib/utils";

export async function POST(request: Request) {
  let email = "";
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      first_name?: string;
      last_name?: string;
      attributes?: Record<string, string>;
    };
    email = body.email?.trim() || "";

    if (!body.email || !body.password) {
      logAuthError("identity-signup", "missing credentials", {
        source: "server",
        origin: "next-api",
        event: "signup_validation_failed",
        email: email || undefined,
        errorMessage: "Email and password are required",
      });
      return NextResponse.json(
        authErrorBody("Email and password are required", "next-api"),
        { status: 400 }
      );
    }

    if (typeof body.first_name === "string") {
      const firstNameError = getPersonNameError(body.first_name, "First name");
      if (firstNameError) {
        logAuthError("identity-signup", "invalid first name", {
          source: "server",
          origin: "next-api",
          event: "signup_validation_failed",
          email,
          errorMessage: firstNameError,
        });
        return NextResponse.json(authErrorBody(firstNameError, "next-api"), {
          status: 400,
        });
      }
    }
    if (typeof body.last_name === "string") {
      const lastNameError = getPersonNameError(body.last_name, "Last name");
      if (lastNameError) {
        logAuthError("identity-signup", "invalid last name", {
          source: "server",
          origin: "next-api",
          event: "signup_validation_failed",
          email,
          errorMessage: lastNameError,
        });
        return NextResponse.json(authErrorBody(lastNameError, "next-api"), {
          status: 400,
        });
      }
    }

    const result = await signupEndUser({
      email: body.email,
      password: body.password,
      first_name: body.first_name?.trim(),
      last_name: body.last_name?.trim(),
      attributes: body.attributes,
    });

    logAuthOk("identity-signup", "signup route ok", {
      source: "server",
      origin: "next-api",
      event: "signup_route_ok",
      email: body.email,
      confirmed: result.confirmed,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign up failed";
    logAuthError(
      "identity-signup",
      "signup route failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "signup_route_failed",
        email: email || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
