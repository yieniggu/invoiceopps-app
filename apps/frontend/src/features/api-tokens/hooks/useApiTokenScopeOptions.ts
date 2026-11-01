import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgGroupsKey } from "../../auth/session/queryKeys";
import type { Profile } from "../../auth/types";
import { listGroups } from "../../groups/api/groupsApi";
import type { Group } from "../../groups/types";
import type { OrganizationGroups } from "../../invoices/invoiceScopes";
import { tokenScopeOptions } from "../apiTokenScopes";

// Same cache entry and freshness as the invoice scope selectors.
const GROUPS_STALE_TIME_MS = 60_000;

// Module-level so useQueries keeps its result referentially stable.
const keepGroups = (results: Array<{ data: Group[] | undefined }>) =>
  results.map(({ data }) => data);

/**
 * Scopes the form offers, and the groups the API lists for the organizations
 * where the person holds an organization-wide invoice permission (the profile
 * only lists the groups a person belongs to). While that list loads, or if it
 * fails, the profile's own options stay.
 */
export function useApiTokenScopeOptions(profile: Profile) {
  const identityId = useIdentityId();
  const organizationIds = useMemo(
    () =>
      profile.memberships
        .filter(({ permissions }) => Object.values(permissions).some(Boolean))
        .map(({ organization }) => organization.id),
    [profile],
  );
  const groups = useQueries({
    queries: organizationIds.map((organizationId) => ({
      queryKey: orgGroupsKey(identityId, organizationId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listGroups(organizationId, signal),
      staleTime: GROUPS_STALE_TIME_MS,
    })),
    combine: keepGroups,
  });
  const organizationGroups = useMemo<OrganizationGroups>(
    () =>
      new Map(
        organizationIds.flatMap((organizationId, index) => {
          const listed = groups[index];
          return listed ? [[organizationId, listed] as const] : [];
        }),
      ),
    [organizationIds, groups],
  );
  const options = useMemo(
    () => tokenScopeOptions(profile, organizationGroups),
    [profile, organizationGroups],
  );
  return { options, organizationGroups };
}
