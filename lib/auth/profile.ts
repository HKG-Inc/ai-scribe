import type { AppDispatch } from "@/store";
import { setUser } from "@/store/slices/userSlice";
import type { EndUserProfile, UpdateEndUserInput } from "@/lib/auth/identity";
import {
  cacheCompanionDoctorId,
  resolveCompanionDoctorIdFromProfile,
} from "@/lib/auth/doctorId";
import { getIdentitySession } from "@/lib/auth/session";
import { apiFetch } from "@/lib/utils";
import { toUserFacingApiError } from "@/lib/api-errors";

export function mapEndUserToUserFields(profile: EndUserProfile) {
  return {
    firstName: profile.first_name?.trim() || "",
    lastName: profile.last_name?.trim() || "",
    email: profile.email?.trim() || "",
    speciality: profile.role?.trim() || "",
  };
}

async function parseEndUserResponse(response: Response): Promise<EndUserProfile> {
  const data = (await response.json()) as EndUserProfile & { error?: string };
  if (!response.ok || data.error) {
    throw new Error(
      toUserFacingApiError(data.error || "Request failed", "Profile request failed")
    );
  }
  return data;
}

export async function fetchEndUserProfile(userId: string): Promise<EndUserProfile> {
  const response = await apiFetch(`/api/identity/end-users/${encodeURIComponent(userId)}`);
  return parseEndUserResponse(response);
}

export async function updateEndUserProfile(
  userId: string,
  input: UpdateEndUserInput
): Promise<EndUserProfile> {
  const response = await apiFetch(`/api/identity/end-users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseEndUserResponse(response);
}

/** Load platform profile into Redux when a user_id is available. */
export async function syncEndUserProfile(dispatch: AppDispatch): Promise<EndUserProfile | null> {
  const session = getIdentitySession();
  const userId = session?.userId?.trim();
  if (!userId) {
    return null;
  }

  const profile = await fetchEndUserProfile(userId);
  dispatch(setUser(mapEndUserToUserFields(profile)));
  const companionDoctor = resolveCompanionDoctorIdFromProfile(profile);
  if (companionDoctor.doctorId) {
    cacheCompanionDoctorId(companionDoctor.doctorId);
  }
  console.log("[identity] companion doctorId", {
    userId,
    companionDoctorId: companionDoctor.doctorId,
    source: companionDoctor.source,
    metadata: profile.metadata,
  });
  return profile;
}
