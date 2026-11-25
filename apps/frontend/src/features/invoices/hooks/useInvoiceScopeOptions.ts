import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgGroupsKey, orgsAllKey } from "../../auth/session/queryKeys";
import type { Profile } from "../../auth/types";
import { listGroups } from "../../groups/api/groupsApi";
import { listAllOrganizations } from "../../orgs/api/orgsApi";
import {
  defaultInvoiceScopeOption,
  invoiceOrganizationChoices,
  invoiceScopeOptions,
  readsWholeOrganizationById,
} from "../invoiceScopes";

// The organization's groups change rarely and the inbox is reopened often.
const GROUPS_STALE_TIME_MS = 60_000;

const ORGANIZATIONS_STALE_TIME_MS = 60_000;

/**
 * Scopes the inbox offers. Organizations: every one for the platform
 * administrator (all pages of the directory, bounded), the memberships'
 * otherwise. The profile lists only the groups a person belongs to, but an
 * organization-wide reader (platform administrator, ADMIN or organization
 * read) may open any group's invoices, so the groups of the *selected*
 * organization come from the organization's own list (the same entry the
 * groups screens use); other organizations are not asked until selected, so a
 * platform administrator never fans out one request per organization. While a
 * list loads or after it fails the profile's options stay; `awaitingGroups`
 * says the selected organization's groups are still loading (a URL naming an
 * unlisted group can wait instead of falling back), and `groupsFailed` /
 * `groupsFetching` / `retryGroups` let the screen say so and try again.
 * `awaitingOrganizations` is the same for the platform directory;
 * `organizationsTruncated` says the bound left organizations out.
 */
export function useInvoiceScopeOptions(
  profile: Profile,
  requestedOrganizationId: string | undefined,
) {
  const identityId = useIdentityId();
  const platform = profile.isPlatformAdministrator;
  const directory = useQuery({
    queryKey: orgsAllKey(identityId),
    queryFn: ({ signal }) => listAllOrganizations(signal),
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
    enabled: platform,
  });
  const platformOrganizations = useMemo(
    () => directory.data?.organizations.map(({ id, name }) => ({ id, name })),
    [directory.data],
  );
  const baseOptions = useMemo(
    () => invoiceScopeOptions(profile, new Map(), platformOrganizations),
    [profile, platformOrganizations],
  );
  // The organization whose groups are listed: the URL's when it is offered,
  // else the one the inbox would open.
  const directoryPending = platform && directory.isPending;
  const targetOrganizationId = useMemo(() => {
    const organizationIds = invoiceOrganizationChoices(baseOptions).map(
      ({ id }) => id,
    );
    if (
      requestedOrganizationId &&
      organizationIds.includes(requestedOrganizationId)
    )
      return requestedOrganizationId;
    // The platform administrator's default depends on the whole directory:
    // choosing before it arrives would list the groups of the wrong organization.
    if (directoryPending) return undefined;
    return defaultInvoiceScopeOption(baseOptions)?.organizationId;
  }, [baseOptions, requestedOrganizationId, directoryPending]);
  const listsGroups =
    targetOrganizationId !== undefined &&
    readsWholeOrganizationById(profile, targetOrganizationId);
  const groupsQuery = useQuery({
    queryKey: orgGroupsKey(identityId, targetOrganizationId ?? ""),
    queryFn: ({ signal }) => listGroups(targetOrganizationId ?? "", signal),
    staleTime: GROUPS_STALE_TIME_MS,
    enabled: listsGroups,
  });
  const options = useMemo(
    () =>
      invoiceScopeOptions(
        profile,
        new Map(
          targetOrganizationId && groupsQuery.data
            ? [[targetOrganizationId, groupsQuery.data] as const]
            : [],
        ),
        platformOrganizations,
      ),
    [profile, targetOrganizationId, groupsQuery.data, platformOrganizations],
  );
  const groupsPending = listsGroups && groupsQuery.isPending;
  return {
    options,
    // The selected organization, while its groups load (empty otherwise).
    loadingOrganizationIds:
      groupsPending && targetOrganizationId ? [targetOrganizationId] : [],
    // True until the platform directory answers (or fails).
    awaitingOrganizations: platform && directory.isPending,
    organizationsTruncated: directory.data?.truncated === true,
    organizationsFailed: platform && directory.isError,
    groupsFailed:
      // A retry of a query without data is «pending» while it fetches; its
      // failure is still the newest outcome, so the notice (and the focused
      // «Reintentar» in it) stays until the retry ends.
      listsGroups &&
      (groupsQuery.isError ||
        (groupsQuery.isFetching &&
          groupsQuery.errorUpdatedAt > groupsQuery.dataUpdatedAt)),
    groupsFetching: groupsQuery.isFetching,
    retryGroups: () => {
      if (groupsQuery.isError) void groupsQuery.refetch();
      if (directory.isError) void directory.refetch();
    },
  };
}
