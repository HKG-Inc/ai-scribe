"use client";

import { apiFetch } from "@/lib/utils";

const SESSION_KEY = "hikigai.identity.session";

export type IdentitySession = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  userSub: string | null;
  userId: string | null;
  email: string;
};

export type IdTokenClaims = {
  sub?: string;
  email?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  phone_number?: string;
  role?: string;
  "custom:role"?: string;
  "custom:specialty"?: string;
  "custom:clinic_name"?: string;
  "custom:phone"?: string;
  "custom:minutes-left"?: string;
  [key: string]: unknown;
};

export type PendingSignupProfile = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  speciality: string;
  clinicName: string;
};

const PENDING_PROFILE_KEY = "hikigai.identity.pendingProfile";

function canUseStorage() {
  return typeof window !== "undefined";
}

export function savePendingSignupProfile(profile: PendingSignupProfile): void {
  if (!canUseStorage()) return;
  sessionStorage.setItem(PENDING_PROFILE_KEY, JSON.stringify(profile));
}

export function consumePendingSignupProfile(): PendingSignupProfile | null {
  if (!canUseStorage()) return null;
  try {
    const raw = sessionStorage.getItem(PENDING_PROFILE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_PROFILE_KEY);
    return JSON.parse(raw) as PendingSignupProfile;
  } catch {
    return null;
  }
}

export function decodeIdToken(idToken: string): IdTokenClaims | null {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(atob(padded)) as IdTokenClaims;
  } catch {
    return null;
  }
}

export function getIdentitySession(): IdentitySession | null {
  if (!canUseStorage()) return null;

  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IdentitySession;
  } catch {
    return null;
  }
}

export function setIdentitySession(session: IdentitySession): void {
  if (!canUseStorage()) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearIdentitySession(): void {
  if (!canUseStorage()) return;
  localStorage.removeItem(SESSION_KEY);
  try {
    sessionStorage.removeItem("hikigai.companion.doctorId");
  } catch {
    // ignore
  }
}

export function hasValidIdentitySession(session = getIdentitySession()): boolean {
  if (!session?.accessToken && !session?.idToken) {
    return false;
  }
  // Allow a short grace period for clock skew; refresh handles expiry.
  return session.expiresAt > Date.now() - 60_000 || Boolean(session.refreshToken);
}

export function sessionFromLoginResponse(
  data: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    user_sub?: string;
    user_id?: string;
  },
  email: string
): IdentitySession {
  const claims = decodeIdToken(data.id_token);
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type || "Bearer",
    userSub: data.user_sub ?? claims?.sub ?? null,
    userId: data.user_id ?? null,
    email: email || claims?.email || "",
  };
}

export async function identityApi<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    throw new Error(
      response.status === 404
        ? `Identity API not found (${path}). Check that the request includes the app base path.`
        : `Identity API returned a non-JSON response (${response.status}).`
    );
  }

  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

export async function refreshIdentitySession(): Promise<IdentitySession | null> {
  const current = getIdentitySession();
  if (!current?.refreshToken) {
    return null;
  }

  try {
    const data = await identityApi<{
      id_token: string;
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    }>("/api/identity/refresh", {
      refresh_token: current.refreshToken,
    });

    const next = sessionFromLoginResponse(
      {
        ...data,
        refresh_token: data.refresh_token || current.refreshToken,
        user_sub: current.userSub ?? undefined,
        user_id: current.userId ?? undefined,
      },
      current.email
    );
    setIdentitySession(next);
    return next;
  } catch {
    clearIdentitySession();
    return null;
  }
}

export async function ensureIdentitySession(): Promise<IdentitySession | null> {
  const current = getIdentitySession();
  if (!current) return null;

  const refreshSoon = current.expiresAt - Date.now() < 5 * 60_000;
  if (!refreshSoon) {
    return current;
  }

  return refreshIdentitySession();
}
