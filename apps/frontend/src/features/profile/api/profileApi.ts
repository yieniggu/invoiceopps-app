import { readApiError } from "../../auth/api/apiError";
import { protectedFetch } from "../../auth/api/protectedFetch";
import type { Profile } from "../../auth/types";

export async function patchProfile(
  contact: { email: string; username: string },
  expectedProfileId: string,
): Promise<Profile> {
  const response = await protectedFetch("/api/v1/profile", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contact),
  });
  if (!response.ok) throw await readApiError(response);
  const { profile } = (await response.json()) as { profile: Profile };
  // An answer for somebody else is never adopted.
  if (profile.id !== expectedProfileId)
    throw new Error("Profile actor mismatch");
  return profile;
}
