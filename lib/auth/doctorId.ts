"use client";

import type { EndUserProfile } from "@/lib/auth/identity";
import {
  decodeIdToken,
  getIdentitySession,
} from "@/lib/auth/session";
import { apiFetch } from "@/lib/utils";

const COMPANION_DOCTOR_ID_KEY = "hikigai.companion.doctorId";
const DOCTOR_ID_KEYS = ["doctorID", "doctorId", "doctor_id", "doctorid"] as const;

function asTrimmedId(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "object") return metadata as Record<string, unknown>;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Same metadata keys CarePilot accepts for the doctor's identifier. */
export function doctorIdFromMetadata(metadata: unknown): string {
  const parsed = parseMetadata(metadata);
  if (!parsed) return "";
  for (const key of DOCTOR_ID_KEYS) {
    const value = asTrimmedId(parsed[key]);
    if (value) return value;
  }
  return "";
}

export function getCachedCompanionDoctorId(): string {
  if (typeof window === "undefined") return "";
  try {
    return sessionStorage.getItem(COMPANION_DOCTOR_ID_KEY)?.trim() || "";
  } catch {
    return "";
  }
}

export function cacheCompanionDoctorId(doctorId: string): void {
  if (typeof window === "undefined") return;
  const trimmed = doctorId.trim();
  if (!trimmed) return;
  try {
    sessionStorage.setItem(COMPANION_DOCTOR_ID_KEY, trimmed);
  } catch {
    // ignore
  }
}

export function clearCachedCompanionDoctorId(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(COMPANION_DOCTOR_ID_KEY);
  } catch {
    // ignore
  }
}

function doctorIdFromClaims(): string {
  const session = getIdentitySession();
  if (!session?.idToken) return "";
  const claims = decodeIdToken(session.idToken);
  if (!claims) return "";

  for (const key of DOCTOR_ID_KEYS) {
    const custom = asTrimmedId(claims[`custom:${key}`]);
    if (custom) return custom;
  }
  return doctorIdFromMetadata(claims["custom:metadata"]);
}

function fallbackDoctorId(): string {
  const session = getIdentitySession();
  return session?.userId?.trim() || session?.userSub?.trim() || "";
}

/**
 * Companion / relay doctor id.
 * Priority matches CarePilot's identifier set:
 * metadata.doctorID → platform user id → Cognito sub.
 */
export function resolveCompanionDoctorIdFromProfile(
  profile?: Pick<EndUserProfile, "id" | "external_subject" | "metadata"> | null
): { doctorId: string; source: "metadata" | "userId" | "userSub" | "" } {
  const fromProfileMetadata = doctorIdFromMetadata(profile?.metadata);
  if (fromProfileMetadata) {
    return { doctorId: fromProfileMetadata, source: "metadata" };
  }

  const fromClaims = doctorIdFromClaims();
  if (fromClaims) {
    return { doctorId: fromClaims, source: "metadata" };
  }

  const session = getIdentitySession();
  const userId = profile?.id?.trim() || session?.userId?.trim() || "";
  if (userId) {
    return { doctorId: userId, source: "userId" };
  }

  const userSub =
    profile?.external_subject?.trim() || session?.userSub?.trim() || "";
  if (userSub) {
    return { doctorId: userSub, source: "userSub" };
  }

  return { doctorId: "", source: "" };
}

export async function loadCompanionDoctorId(): Promise<string> {
  const cached = getCachedCompanionDoctorId();
  if (cached) return cached;

  const session = getIdentitySession();
  if (session?.userId) {
    try {
      const response = await apiFetch(
        `/api/identity/end-users/${encodeURIComponent(session.userId)}`
      );
      const profile = (await response.json()) as EndUserProfile & { error?: string };
      if (response.ok && !profile.error) {
        const resolved = resolveCompanionDoctorIdFromProfile(profile);
        if (resolved.doctorId) {
          cacheCompanionDoctorId(resolved.doctorId);
          console.log("[identity] companion doctorId", resolved);
          return resolved.doctorId;
        }
      }
    } catch (error) {
      console.warn("[identity] failed to load profile for companion doctorId", error);
    }
  }

  const resolved = resolveCompanionDoctorIdFromProfile(null);
  if (resolved.doctorId) {
    cacheCompanionDoctorId(resolved.doctorId);
    console.log("[identity] companion doctorId", resolved);
  }
  return resolved.doctorId || fallbackDoctorId();
}
