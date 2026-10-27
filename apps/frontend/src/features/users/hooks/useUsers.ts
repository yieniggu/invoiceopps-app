import { useMutation, useQuery } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgUsersKey } from "../../auth/session/queryKeys";
import { useInvalidateOrgPeople } from "../../orgs/hooks/useOrgMembers";
import { listOrganizationUsers, provisionUser } from "../api/usersApi";
import type { IssuedCredential, ProvisionUserInput } from "../types";

export function useOrgUsersQuery(organizationId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgUsersKey(identityId, organizationId),
    queryFn: ({ signal }) => listOrganizationUsers(organizationId, signal),
  });
}

/**
 * `deliver` receives the one-time temporary password. It is not part of the
 * mutation variables or result, so it never enters the MutationCache.
 */
export function useProvisionUser(
  organizationId: string,
  deliver: (credential: IssuedCredential) => void,
) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  return useMutation({
    mutationFn: (input: ProvisionUserInput) =>
      provisionUser(organizationId, input, deliver),
    onSuccess: () => invalidate(),
  });
}
