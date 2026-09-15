import { NextResponse } from "next/server";
import { getEndUser, updateEndUser, type UpdateEndUserInput } from "@/lib/auth/identity";
import { authErrorBody, logAuthError, logAuthOk } from "@/lib/auth/log";
import { getPersonNameError } from "@/lib/utils";

type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  let userId = "";
  try {
    ({ userId } = await context.params);
    if (!userId?.trim()) {
      logAuthError("identity-end-user", "missing user id", {
        source: "server",
        origin: "next-api",
        event: "get_end_user_validation_failed",
        errorMessage: "User ID is required",
      });
      return NextResponse.json(authErrorBody("User ID is required", "next-api"), {
        status: 400,
      });
    }

    const result = await getEndUser(userId.trim());
    logAuthOk("identity-end-user", "get end-user ok", {
      source: "server",
      origin: "next-api",
      event: "get_end_user_route_ok",
      userId: userId.trim(),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch profile";
    logAuthError(
      "identity-end-user",
      "get end-user failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "get_end_user_route_failed",
        userId: userId || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  let userId = "";
  try {
    ({ userId } = await context.params);
    if (!userId?.trim()) {
      logAuthError("identity-end-user", "missing user id", {
        source: "server",
        origin: "next-api",
        event: "update_end_user_validation_failed",
        errorMessage: "User ID is required",
      });
      return NextResponse.json(authErrorBody("User ID is required", "next-api"), {
        status: 400,
      });
    }

    const body = (await request.json()) as UpdateEndUserInput;
    const payload: UpdateEndUserInput = {};

    if (typeof body.first_name === "string") {
      const firstNameError = getPersonNameError(body.first_name, "First name");
      if (firstNameError) {
        return NextResponse.json(authErrorBody(firstNameError, "next-api"), {
          status: 400,
        });
      }
      payload.first_name = body.first_name.trim();
    }
    if (typeof body.last_name === "string") {
      const lastNameError = getPersonNameError(body.last_name, "Last name");
      if (lastNameError) {
        return NextResponse.json(authErrorBody(lastNameError, "next-api"), {
          status: 400,
        });
      }
      payload.last_name = body.last_name.trim();
    }
    if (typeof body.role === "string") {
      payload.role = body.role;
    }
    if (typeof body.is_active === "boolean") {
      payload.is_active = body.is_active;
    }
    if (body.metadata !== undefined) {
      payload.metadata = body.metadata;
    }

    if (Object.keys(payload).length === 0) {
      return NextResponse.json(
        authErrorBody("No profile fields to update", "next-api"),
        { status: 400 }
      );
    }

    const result = await updateEndUser(userId.trim(), payload);
    logAuthOk("identity-end-user", "update end-user ok", {
      source: "server",
      origin: "next-api",
      event: "update_end_user_route_ok",
      userId: userId.trim(),
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update profile";
    logAuthError(
      "identity-end-user",
      "update end-user failed",
      {
        source: "server",
        origin: "hikigai-backend",
        event: "update_end_user_route_failed",
        userId: userId || undefined,
        errorMessage: message,
      },
      error
    );
    return NextResponse.json(authErrorBody(message), { status: 400 });
  }
}
