import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgsKey, profileKey } from "../../auth/session/queryKeys";
import { createOrganization, listOrganizations } from "../api/orgsApi";

/** Platform-wide list; organization members never need it. */
export function useOrganizationsQuery(enabled: boolean) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgsKey(identityId),
    queryFn: ({ signal }) => listOrganizations(signal),
    enabled,
  });
}

export function useCreateOrganization() {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      // The first administrator may be the actor: memberships changed too.
      void client.invalidateQueries({ queryKey: orgsKey(identityId) });
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
    },
  });
}
