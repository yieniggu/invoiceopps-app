import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgGroupsKey } from "../../auth/session/queryKeys";
import type { Profile } from "../../auth/types";
import { listGroups } from "../../groups/api/groupsApi";
import type { Group } from "../../groups/types";
import { invoiceScopeOptions } from "../invoiceScopes";

// The organization's groups change rarely and the inbox is reopened often.
const GROUPS_STALE_TIME_MS = 60_000;

// Module-level so useQueries keeps its result referentially stable.
const keepGroupsAndPending = (
  results: Array<{
    data: Group[] | undefined;
    isPending: boolean;
    isError: boolean;
    isFetching: boolean;
    errorUpdatedAt: number;
    dataUpdatedAt: number;
    refetch: () => unknown;
  }>,
) => ({
  groups: results.map(({ data }) => data),
  pending: results.map(({ isPending }) => isPending),
  // A retry of a query without data puts it back to «pending» (no `isError`)
  // while it fetches; its failure is still the newest outcome of the entry, so
  // the notice (and the focused «Reintentar» in it) stays until the retry ends.
  failed: results.some(
    ({ isError, isFetching, errorUpdatedAt, dataUpdatedAt }) =>
      isError || (isFetching && errorUpdatedAt > dataUpdatedAt),
  ),
  fetching: results.some(({ isFetching }) => isFetching),
  retryFailed: () => {
    for (const result of results) if (result.isError) void result.refetch();
  },
});

/**
 * Scopes the inbox offers. The profile lists only the groups a person
 * belongs to, but an organization-wide reader may open any group's invoices,
 * so for the organizations where the person has organization read the groups
 * come from the organization's own list (the same entry the groups screens
 * use). Nobody else asks for it. While that list loads or after it fails the
 * profile's options stay; `loadingOrganizationIds` lists those still
 * loading, so a URL naming an unlisted group can wait instead of falling back,
 * and `groupsFailed` / `groupsFetching` / `retryGroups` let the screen say so and try again.
 */
export function useInvoiceScopeOptions(profile: Profile) {
  const identityId = useIdentityId();
  const readerOrganizationIds = useMemo(
    () =>
      profile.memberships
        .filter(({ permissions }) => permissions.readInvoices)
        .map(({ organization }) => organization.id),
    [profile],
  );
  const {
    groups,
    pending,
    failed,
    fetching,
    retryFailed: retryGroups,
  } = useQueries({
    queries: readerOrganizationIds.map((organizationId) => ({
      queryKey: orgGroupsKey(identityId, organizationId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listGroups(organizationId, signal),
      staleTime: GROUPS_STALE_TIME_MS,
    })),
    combine: keepGroupsAndPending,
  });

  const options = useMemo(
    () =>
      invoiceScopeOptions(
        profile,
        new Map(
          readerOrganizationIds.flatMap((organizationId, index) => {
            const listed = groups[index];
            return listed ? [[organizationId, listed] as const] : [];
          }),
        ),
      ),
    [profile, readerOrganizationIds, groups],
  );
  const loadingOrganizationIds = readerOrganizationIds.filter(
    (_, index) => pending[index],
  );
  return {
    options,
    loadingOrganizationIds,
    groupsFailed: failed,
    groupsFetching: fetching,
    retryGroups,
  };
}
