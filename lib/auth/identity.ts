import { randomUUID } from "crypto";
import { HIKIGAI_BACKEND_URL_DEFAULT } from "@/lib/hikigai";
import { logAuthError, logAuthOk } from "@/lib/auth/log";
import { parseRawResponse } from "@/lib/logger";

const USER_AGENT = "hikigai-sdk/0.0.1";

export type IdentitySignupResult = {
  user_sub: string | null;
  user_id: string;
  email: string;
  confirmed: boolean;
};

export type IdentityLoginSuccess = {
  status: "authenticated";
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user_sub?: string;
  user_id?: string;
};

export type IdentityLoginChallenge = {
  status: "challenge";
  challenge_name: string;
  session: string;
};

export type IdentityLoginResult = IdentityLoginSuccess | IdentityLoginChallenge;

export type IdentityRefreshResult = {
  status: "authenticated";
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export type IdentityAppConfig = {
  app_id: string;
  project_id: string;
  mode: string;
  status: string;
  cognito_pool_id: string | null;
  cognito_client_id: string | null;
  cognito_region: string | null;
  enabled_methods: string[];
  error_message: string | null;
};

function getBackendUrl() {
  return process.env.HIKIGAI_BACKEND_URL || HIKIGAI_BACKEND_URL_DEFAULT;
}

function getApiKey() {
  const apiKey = process.env.HIKIGAI_API_KEY || "";
  if (!apiKey) {
    throw new Error("Missing HIKIGAI_API_KEY");
  }
  return apiKey;
}

function getProjectId() {
  const projectId = process.env.HIKIGAI_PROJECT_ID || "";
  if (!projectId) {
    throw new Error("Missing HIKIGAI_PROJECT_ID");
  }
  return projectId;
}

export function getAppId() {
  const appId = process.env.HIKIGAI_APP_ID || "";
  if (!appId) {
    throw new Error("Missing HIKIGAI_APP_ID");
  }
  return appId;
}

function identityHeaders(contentType = false): HeadersInit {
  const headers: Record<string, string> = {
    "X-API-Key": getApiKey(),
    "X-Project-ID": getProjectId(),
    "User-Agent": USER_AGENT,
  };
  if (contentType) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function messageFromRawBody(rawText: string, fallback: string): string {
  if (!rawText) return fallback;
  try {
    const data = JSON.parse(rawText) as {
      detail?: string | { msg?: string }[];
      message?: string;
      error?: string;
      error_message?: string;
    };
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail) && data.detail[0]?.msg) return data.detail[0].msg;
    if (typeof data.message === "string") return data.message;
    if (typeof data.error === "string") return data.error;
    if (typeof data.error_message === "string") return data.error_message;
  } catch {
    // fall through
  }
  return rawText;
}

async function identityFetch<T>(
  path: string,
  init: RequestInit,
  fallbackError: string,
  meta?: { event?: string; email?: string }
): Promise<T> {
  const url = `${getBackendUrl()}${path}`;
  const event = meta?.event ?? "identity_request";
  const method = (init.method || "GET").toUpperCase();

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    logAuthError(
      "identity-backend",
      "network failure calling hikigai identity",
      {
        source: "server",
        origin: "hikigai-backend",
        event: `${event}_network_error`,
        path,
        url,
        method,
        ...(meta?.email ? { email: meta.email } : {}),
        errorMessage: cause instanceof Error ? cause.message : String(cause),
      },
      cause
    );
    throw new Error(
      cause instanceof Error ? cause.message : "Identity service unreachable"
    );
  }

  if (!response.ok) {
    const rawText = await response.text();
    const errorMessage = messageFromRawBody(rawText, fallbackError);

    logAuthError("identity-backend", "hikigai identity request failed", {
      source: "server",
      origin: "hikigai-backend",
      event: `${event}_failed`,
      path,
      url,
      method,
      status: response.status,
      statusText: response.statusText,
      errorMessage,
      rawResponse: parseRawResponse(rawText),
      ...(meta?.email ? { email: meta.email } : {}),
    });
    throw new Error(errorMessage || fallbackError);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function getIdentityConfig(): Promise<IdentityAppConfig> {
  return identityFetch<IdentityAppConfig>(
    `/api/v1/identity/apps/${getAppId()}`,
    {
      method: "GET",
      headers: identityHeaders(),
    },
    "Failed to fetch identity config",
    { event: "identity_config" }
  );
}

export async function signupEndUser(input: {
  email: string;
  password: string;
  first_name?: string;
  last_name?: string;
  attributes?: Record<string, string>;
}): Promise<IdentitySignupResult> {
  const result = await identityFetch<IdentitySignupResult>(
    "/api/v1/identity/signup",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        ...input,
      }),
    },
    "Sign up failed",
    { event: "signup", email: input.email }
  );
  logAuthOk("identity-backend", "signup ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "signup_ok",
    email: input.email,
    confirmed: result.confirmed,
  });

  // Stable companion/relay id — set once at signup so CarePilot can join by doctorID.
  const userId = result.user_id?.trim();
  if (userId) {
    const doctorID = randomUUID();
    try {
      await updateEndUser(userId, { metadata: { doctorID } });
      logAuthOk("identity-backend", "signup doctorID assigned", {
        source: "server",
        origin: "hikigai-backend",
        event: "signup_doctor_id_ok",
        email: input.email,
        userId,
      });
    } catch (error) {
      logAuthError(
        "identity-backend",
        "signup doctorID assignment failed",
        {
          source: "server",
          origin: "hikigai-backend",
          event: "signup_doctor_id_failed",
          email: input.email,
          userId,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        error
      );
    }
  }

  return result;
}

export async function confirmEndUser(input: {
  email: string;
  code: string;
}): Promise<{ success: boolean; message: string }> {
  const result = await identityFetch<{ success: boolean; message: string }>(
    "/api/v1/identity/confirm",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        ...input,
      }),
    },
    "Confirmation failed",
    { event: "confirm", email: input.email }
  );
  logAuthOk("identity-backend", "confirm ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "confirm_ok",
    email: input.email,
  });
  return result;
}

export async function loginEndUser(input: {
  email: string;
  password: string;
}): Promise<IdentityLoginResult> {
  const result = await identityFetch<IdentityLoginResult>(
    "/api/v1/identity/login",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        ...input,
      }),
    },
    "Sign in failed",
    { event: "login", email: input.email }
  );
  logAuthOk("identity-backend", "login ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "login_ok",
    email: input.email,
    loginStatus: result.status,
    ...(result.status === "challenge"
      ? { challengeName: result.challenge_name }
      : {}),
  });
  return result;
}

export async function refreshEndUser(refreshToken: string): Promise<IdentityRefreshResult> {
  const result = await identityFetch<IdentityRefreshResult>(
    "/api/v1/identity/refresh",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        refresh_token: refreshToken,
      }),
    },
    "Token refresh failed",
    { event: "refresh" }
  );
  logAuthOk("identity-backend", "refresh ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "refresh_ok",
  });
  return result;
}

export async function logoutEndUser(email: string): Promise<{ success: boolean; message: string }> {
  const result = await identityFetch<{ success: boolean; message: string }>(
    "/api/v1/identity/logout",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        email,
      }),
    },
    "Logout failed",
    { event: "logout", email }
  );
  logAuthOk("identity-backend", "logout ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "logout_ok",
    email,
  });
  return result;
}

export async function forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
  const result = await identityFetch<{ success: boolean; message: string }>(
    "/api/v1/identity/forgot-password",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        email,
      }),
    },
    "Failed to request password reset",
    { event: "forgot_password", email }
  );
  logAuthOk("identity-backend", "forgot-password ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "forgot_password_ok",
    email,
  });
  return result;
}

export async function resetPassword(input: {
  email: string;
  code: string;
  new_password: string;
}): Promise<{ success: boolean; message: string }> {
  const result = await identityFetch<{ success: boolean; message: string }>(
    "/api/v1/identity/reset-password",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        ...input,
      }),
    },
    "Failed to reset password",
    { event: "reset_password", email: input.email }
  );
  logAuthOk("identity-backend", "reset-password ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "reset_password_ok",
    email: input.email,
  });
  return result;
}

export async function changePassword(input: {
  access_token: string;
  current_password: string;
  new_password: string;
}): Promise<{ success: boolean; message: string }> {
  const result = await identityFetch<{ success: boolean; message: string }>(
    "/api/v1/identity/change-password",
    {
      method: "POST",
      headers: identityHeaders(true),
      body: JSON.stringify({
        app_id: getAppId(),
        ...input,
      }),
    },
    "Failed to change password",
    { event: "change_password" }
  );
  logAuthOk("identity-backend", "change-password ok", {
    source: "server",
    origin: "hikigai-backend",
    event: "change_password_ok",
  });
  return result;
}

export type EndUserProfile = {
  id: string;
  project_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string | null;
  external_subject: string | null;
  is_active: boolean;
  qr_issued?: boolean;
  metadata: Record<string, unknown> | null;
  created_at?: string;
  last_verified_at?: string | null;
};

export type UpdateEndUserInput = {
  role?: string;
  first_name?: string;
  last_name?: string;
  metadata?: Record<string, unknown> | null;
  is_active?: boolean;
};

export async function getEndUser(userId: string): Promise<EndUserProfile> {
  return identityFetch<EndUserProfile>(
    `/api/v1/end-users/${encodeURIComponent(userId)}`,
    {
      method: "GET",
      headers: identityHeaders(),
    },
    "Failed to fetch profile",
    { event: "get_end_user" }
  );
}

export async function updateEndUser(
  userId: string,
  input: UpdateEndUserInput
): Promise<EndUserProfile> {
  return identityFetch<EndUserProfile>(
    `/api/v1/end-users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: identityHeaders(true),
      body: JSON.stringify(input),
    },
    "Failed to update profile",
    { event: "update_end_user" }
  );
}
