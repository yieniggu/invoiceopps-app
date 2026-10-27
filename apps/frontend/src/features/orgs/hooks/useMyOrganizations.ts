import type { Profile } from "../../auth/types";
import type { Organization } from "../types";
import { useOrganizationsQuery } from "./useOrganizations";

type MyOrganization = Organization & { role: string };

/**
 * The organizations the person belongs to. The endpoint lists every
 * organization for the platform administrator, so the answer is narrowed to
 * the profile's memberships (platform authority is not membership).
 */
export function useMyOrganizations(profile: Profile) {
  const query = useOrganizationsQuery(profile.memberships.length > 0);
  const roles = new Map(
    profile.memberships.map(({ organization, role }) => [
      organization.id,
      role,
    ]),
  );
  const organizations: MyOrganization[] | undefined = query.data
    ?.filter(({ id }) => roles.has(id))
    .map((organization) => ({
      ...organization,
      role: roles.get(organization.id) ?? "USER",
    }));
  return { query, organizations };
}
