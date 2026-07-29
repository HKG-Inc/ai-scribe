import { NextResponse } from "next/server";
import { signupEndUser } from "@/lib/auth/identity";
import { getPersonNameError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      first_name?: string;
      last_name?: string;
      attributes?: Record<string, string>;
    };

    if (!body.email || !body.password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    if (typeof body.first_name === "string") {
      const firstNameError = getPersonNameError(body.first_name, "First name");
      if (firstNameError) {
        return NextResponse.json({ error: firstNameError }, { status: 400 });
      }
    }
    if (typeof body.last_name === "string") {
      const lastNameError = getPersonNameError(body.last_name, "Last name");
      if (lastNameError) {
        return NextResponse.json({ error: lastNameError }, { status: 400 });
      }
    }

    const result = await signupEndUser({
      email: body.email,
      password: body.password,
      first_name: body.first_name?.trim(),
      last_name: body.last_name?.trim(),
      attributes: body.attributes,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sign up failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
