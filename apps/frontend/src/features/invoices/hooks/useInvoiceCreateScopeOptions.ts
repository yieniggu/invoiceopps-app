import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgGroupsKey } from "../../auth/session/queryKeys";
import type { Profile } from "../../auth/types";
import { listGroups } from "../../groups/api/groupsApi";
import type { Group } from "../../groups/types";
import { createScopeOptions } from "../invoiceCreateScopes";

// Same cache entry and freshness as the inbox's scope selector.
const GROUPS_STALE_TIME_MS = 60_000;

// Module-level so useQueries keeps its result referentially stable.
const keepGroups = (results: Array<{ data: Group[] | undefined }>) =>
  results.map(({ data }) => data);

/**
 * Scopes the form offers. The profile lists only the groups a person belongs
 * to, but organization-wide create reaches every group, so for those
 * organizations the groups the API lists join the profile's. While that list
 * loads, or if it fails, the profile's own options stay.
 */
export function useInvoiceCreateScopeOptions(profile: Profile) {
  const identityId = useIdentityId();
  const creatorOrganizationIds = useMemo(
    () =>
      profile.memberships
        .filter(({ permissions }) => permissions.createInvoices)
        .map(({ organization }) => organization.id),
    [profile],
  );
  const groups = useQueries({
    queries: creatorOrganizationIds.map((organizationId) => ({
      queryKey: orgGroupsKey(identityId, organizationId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listGroups(organizationId, signal),
      staleTime: GROUPS_STALE_TIME_MS,
    })),
    combine: keepGroups,
  });
  return useMemo(
    () =>
      createScopeOptions(
        profile,
        new Map(
          creatorOrganizationIds.flatMap((organizationId, index) => {
            const listed = groups[index];
            return listed ? [[organizationId, listed] as const] : [];
          }),
        ),
      ),
    [profile, creatorOrganizationIds, groups],
  );
}
