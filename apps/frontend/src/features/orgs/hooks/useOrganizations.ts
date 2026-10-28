import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgKey, orgsKey, profileKey } from "../../auth/session/queryKeys";
import {
  createOrganization,
  getOrganization,
  listOrganizations,
} from "../api/orgsApi";

/** Platform-wide list; organization members never need it. */
export function useOrganizationsQuery(enabled: boolean) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgsKey(identityId),
    queryFn: ({ signal }) => listOrganizations(signal),
    enabled,
  });
}

/** Summary of one organization: its data and member and group counts. */
export function useOrganizationQuery(organizationId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgKey(identityId, organizationId),
    queryFn: ({ signal }) => getOrganization(organizationId, signal),
  });
}

/**
 * The summary counts change with members and groups. Its key is a prefix of
 * every other key of the organization, so only this exact entry is refreshed.
 */
export function useInvalidateOrganizationSummary() {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (organizationId: string) =>
    client.invalidateQueries({
      queryKey: orgKey(identityId, organizationId),
      exact: true,
    });
}

export function useCreateOrganization() {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useMutation({
    mutationFn: createOrganization,
    onSuccess: () => {
      // The first administrator may be the actor: memberships changed too.
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
      // Awaited: the list is what the next screen shows.
      return client.invalidateQueries({ queryKey: orgsKey(identityId) });
    },
  });
}
