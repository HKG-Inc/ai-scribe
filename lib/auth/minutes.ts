import type { AppDispatch } from "@/store";
import { setUser } from "@/store/slices/userSlice";
import { setChargedRecordingSeconds } from "@/store/slices/recordingSlice";
import { getIdentitySession } from "@/lib/auth/session";
import { apiFetch } from "@/lib/utils";

export const DEFAULT_SUBSCRIPTION_MINUTES = 2500;
export const MINUTES_LEFT_ATTRIBUTE = "custom:minutes-left";

export function parseMinutesLeft(value: string | undefined | null): number {
  if (value == null || value === "") {
    return DEFAULT_SUBSCRIPTION_MINUTES;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SUBSCRIPTION_MINUTES;
}

/** Active recording seconds → billable minutes (exact float, e.g. 5.5). */
export function recordingSecondsToBillableMinutes(seconds: number): number {
  if (seconds <= 0) return 0;
  return Math.round((seconds / 60) * 100) / 100;
}

function doctorDisplayName(firstName?: string, lastName?: string): string {
  return [firstName, lastName].filter(Boolean).join(" ").trim();
}

/** Prefer platform user_id from login/signup; fall back to email only if missing. */
export function resolveDoctorId(emailFallback = ""): string {
  const session = getIdentitySession();
  return session?.userId?.trim() || emailFallback.trim() || "";
}

function readDoctorFromStore(store: {
  getState: () => {
    user: {
      email: string;
      firstName: string;
      lastName: string;
      totalMinutesLeft: number;
    };
  };
}) {
  const user = store.getState().user;
  return {
    doctorId: resolveDoctorId(user.email),
    doctorName: doctorDisplayName(user.firstName, user.lastName),
    currentBalance: user.totalMinutesLeft ?? DEFAULT_SUBSCRIPTION_MINUTES,
  };
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function fetchMinutesLeftFromSubscription(
  doctorId: string,
  doctorName = ""
): Promise<{ minutesRemaining: number; totalAllocated: number }> {
  const params = new URLSearchParams({ doctor_id: doctorId });
  if (doctorName) {
    params.set("doctor_name", doctorName);
  }

  const response = await apiFetch(`/api/subscription-minutes?${params.toString()}`);
  const data = (await response.json()) as {
    error?: string;
    minutes_remaining?: number;
    total_minutes_allocated?: number;
  };

  if (!response.ok) {
    throw new Error(data.error || "Failed to fetch subscription minutes");
  }

  return {
    minutesRemaining: asFiniteNumber(data.minutes_remaining, DEFAULT_SUBSCRIPTION_MINUTES),
    totalAllocated: asFiniteNumber(data.total_minutes_allocated, DEFAULT_SUBSCRIPTION_MINUTES),
  };
}

export async function syncMinutesLeft(dispatch: AppDispatch): Promise<void> {
  try {
    const { store } = await import("@/store");
    const { doctorId, doctorName } = readDoctorFromStore(store);
    if (!doctorId) return;

    const { minutesRemaining, totalAllocated } = await fetchMinutesLeftFromSubscription(
      doctorId,
      doctorName
    );

    dispatch(
      setUser({
        totalMinutesLeft: minutesRemaining,
        totalMinutesAllowed: totalAllocated,
      })
    );
  } catch {
    // Keep local state.
  }
}

/**
 * Deduct subscription minutes for active recording time not yet billed this visit.
 * Safe to call on Stop Recording and again on End Visit / logout — only the
 * uncharged delta is sent to the API.
 */
export async function chargeVisitMinutesIfNeeded(
  dispatch: AppDispatch,
  recordingTimeSeconds: number
): Promise<void> {
  const { store } = await import("@/store");
  const chargedSeconds = store.getState().recording.chargedRecordingSeconds ?? 0;
  const unchargedSeconds = Math.max(0, recordingTimeSeconds - chargedSeconds);
  const minutesToDeduct = recordingSecondsToBillableMinutes(unchargedSeconds);

  if (minutesToDeduct === 0) {
    return;
  }

  try {
    const { doctorId, doctorName, currentBalance } = readDoctorFromStore(store);

    if (!doctorId) {
      console.error("Cannot deduct minutes: doctor_id (user_id) is missing");
      return;
    }

    const response = await apiFetch("/api/subscription-minutes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        doctor_id: doctorId,
        doctor_name: doctorName,
        consumed_minutes: minutesToDeduct,
      }),
    });

    const data = (await response.json()) as {
      error?: string;
      minutes_remaining?: number;
      balance_after?: number;
    };

    if (!response.ok) {
      throw new Error(data.error || "Failed to deduct subscription minutes");
    }

    const newBalance = asFiniteNumber(
      data.minutes_remaining ?? data.balance_after,
      Math.max(0, currentBalance - minutesToDeduct)
    );

    dispatch(setUser({ totalMinutesLeft: newBalance }));
    dispatch(setChargedRecordingSeconds(recordingTimeSeconds));
  } catch (error) {
    console.error("Failed to deduct visit minutes:", error);
  }
}
