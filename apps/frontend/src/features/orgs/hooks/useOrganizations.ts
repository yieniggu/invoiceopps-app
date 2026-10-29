import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgKey, orgsKey, profileKey } from "../../auth/session/queryKeys";
import {
  createOrganization,
  getOrganization,
  listOrganizations,
  updateOrganization,
} from "../api/orgsApi";
import type { PageRequest, UpdateOrganizationInput } from "../types";

/** One page of the platform directory of organizations (search + paging). */
export function useOrganizationsPageQuery(
  request: PageRequest & { search: string },
  enabled: boolean,
) {
  const identityId = useIdentityId();
  const params = {
    page: request.page,
    pageSize: request.pageSize,
    ...(request.search ? { search: request.search } : {}),
  };
  return useQuery({
    queryKey: orgsKey(identityId, params),
    queryFn: ({ signal }) => listOrganizations(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Summary of one organization: its data and member and group counts. */
export function useOrganizationQuery(organizationId: string, enabled = true) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgKey(identityId, organizationId),
    queryFn: ({ signal }) => getOrganization(organizationId, signal),
    enabled,
  });
}

/**
 * Edits name and description (the slug is immutable). The detail and every
 * page of the directory are refreshed; the profile too, because it carries the
 * organization name for the people who belong to it.
 */
export function useUpdateOrganization(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) =>
      updateOrganization(organizationId, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({
          queryKey: orgKey(identityId, organizationId),
          exact: true,
        }),
        client.invalidateQueries({ queryKey: orgsKey(identityId) }),
        client.invalidateQueries({ queryKey: profileKey(identityId) }),
      ]),
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
