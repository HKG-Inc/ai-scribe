import { NextResponse } from "next/server";
import { getEndUser, updateEndUser, type UpdateEndUserInput } from "@/lib/auth/identity";
import { getPersonNameError } from "@/lib/utils";

type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { userId } = await context.params;
    if (!userId?.trim()) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    const result = await getEndUser(userId.trim());
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch profile";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { userId } = await context.params;
    if (!userId?.trim()) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    const body = (await request.json()) as UpdateEndUserInput;
    const payload: UpdateEndUserInput = {};

    if (typeof body.first_name === "string") {
      const firstNameError = getPersonNameError(body.first_name, "First name");
      if (firstNameError) {
        return NextResponse.json({ error: firstNameError }, { status: 400 });
      }
      payload.first_name = body.first_name.trim();
    }
    if (typeof body.last_name === "string") {
      const lastNameError = getPersonNameError(body.last_name, "Last name");
      if (lastNameError) {
        return NextResponse.json({ error: lastNameError }, { status: 400 });
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
      return NextResponse.json({ error: "No profile fields to update" }, { status: 400 });
    }

    const result = await updateEndUser(userId.trim(), payload);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update profile";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
