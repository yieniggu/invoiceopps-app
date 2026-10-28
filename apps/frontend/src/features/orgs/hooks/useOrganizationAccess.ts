import type { Profile } from "../../auth/types";
import { isAdminRole } from "../types/roles";

/** What the profile says about the person's role in one organization. */
export function useOrganizationAccess(
  profile: Profile,
  organizationId: string | undefined,
) {
  const membership = profile.memberships.find(
    ({ organization }) => organization.id === organizationId,
  );
  const isAdmin = isAdminRole(membership?.role);
  return {
    organization: membership?.organization,
    isMember: membership !== undefined,
    isAdmin,
    /** Organization ADMIN or platform administrator: may manage people. */
    canManage: isAdmin || profile.isPlatformAdministrator,
    membership,
  };
}
