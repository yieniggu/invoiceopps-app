import { isUuid } from "../../../lib/uuid";
import { isApiError } from "../../auth/api/apiError";
import type { Profile } from "../../auth/types";
import { isAdminRole } from "../types/roles";
import { useOrganizationQuery } from "./useOrganizations";

/**
 * What the person may do in one organization.
 * - A member knows it from the profile.
 * - The platform administrator can manage any organization, member or not, so
 *   without a membership the organization is read from the server instead
 *   (`status` says whether that read is still loading, failed, or answered
 *   404 and the organization does not exist).
 * - Anyone else gets `not-found`, whether or not the organization exists.
 */
export function useOrganizationAccess(
  profile: Profile,
  organizationId: string | undefined,
) {
  const membership = profile.memberships.find(
    ({ organization }) => organization.id === organizationId,
  );
  // A malformed id is no organization: no request (the server answers 404).
  const fallbackNeeded =
    membership === undefined &&
    profile.isPlatformAdministrator &&
    isUuid(organizationId ?? "");
  const fallback = useOrganizationQuery(organizationId ?? "", fallbackNeeded);
  const isAdmin = isAdminRole(membership?.role);

  const organization =
    membership?.organization ??
    (fallbackNeeded ? fallback.data?.organization : undefined);
  const status = organization
    ? ("ready" as const)
    : !fallbackNeeded
      ? ("not-found" as const)
      : fallback.isError
        ? isApiError(fallback.error) && fallback.error.status === 404
          ? ("not-found" as const)
          : ("error" as const)
        : ("loading" as const);

  return {
    organization,
    status,
    retry: () => void fallback.refetch(),
    isMember: membership !== undefined,
    isAdmin,
    /** Organization ADMIN or platform administrator: may manage people. */
    canManage: isAdmin || profile.isPlatformAdministrator,
    membership,
  };
}
