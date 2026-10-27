import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";

import { profileKey } from "../../auth/session/queryKeys";
import type { Profile } from "../../auth/types";
import { patchProfile } from "../api/profileApi";

type Contact = { email: string; username: string };
const UPDATE_KEY = ["profile", "update"] as const;

/** Contact values of a save that is still in flight, if any. */
export function usePendingContact() {
  return useMutationState({
    filters: { mutationKey: UPDATE_KEY, status: "pending" },
    select: (mutation) => mutation.state.variables as Contact,
  }).at(-1);
}

export function useUpdateProfile(profileId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: UPDATE_KEY,
    mutationFn: (contact: Contact) => patchProfile(contact, profileId),
    onSuccess: ({ email, username }) =>
      client.setQueryData<Profile>(profileKey(profileId), (current) =>
        current ? { ...current, email, username } : current,
      ),
  });
}
