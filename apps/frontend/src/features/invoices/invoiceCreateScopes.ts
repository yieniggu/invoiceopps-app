import type { Profile } from "../auth/types";
import { invoiceScopeValue, type OrganizationGroups } from "./invoiceScopes";

// Where a person may create an invoice. As with the inbox, the profile only
// decides what the form offers; the API stays the authority (403/404).

type Memberships = Pick<Profile, "memberships">;

export interface CreateScopeOption {
  /** Stable, unique `<option value>` (same format as the inbox scopes). */
  value: string;
  /** Text of the `<option>`; its organization is the group's label. */
  label: string;
  organizationId: string;
  organizationName: string;
  /** `null` is the organization scope: the request then omits `groupId`. */
  groupId: string | null;
  /** The person can also read invoices there, so «Ver factura» can open it. */
  canRead: boolean;
}

export const ORGANIZATION_SCOPE_LABEL = "Organización (sin grupo)";

/**
 * Scopes with effective create, in profile order: per organization the
 * organization scope (organization create) and then its groups. A group
 * counts with its own effective create, or through organization create for
 * every group the organization lists (`organizationGroups`, joined to the
 * profile's own and deduplicated by id).
 */
export function createScopeOptions(
  { memberships }: Memberships,
  organizationGroups: OrganizationGroups = new Map(),
): CreateScopeOption[] {
  return memberships.flatMap(({ organization, permissions, groups }) => {
    const { id: organizationId, name: organizationName } = organization;
    const options: CreateScopeOption[] = [];
    if (permissions.createInvoices)
      options.push({
        value: invoiceScopeValue({ kind: "organization", organizationId }),
        label: ORGANIZATION_SCOPE_LABEL,
        organizationId,
        organizationName,
        groupId: null,
        canRead: permissions.readInvoices,
      });
    const own = groups.filter(
      ({ effective }) => permissions.createInvoices || effective.createInvoices,
    );
    const known = new Set(own.map(({ group }) => group.id));
    const unlisted = permissions.createInvoices
      ? (organizationGroups.get(organizationId) ?? []).filter(
          ({ id }) => !known.has(id),
        )
      : [];
    for (const { group, effective } of own)
      options.push(
        groupOption(organizationId, organizationName, group, {
          canRead: permissions.readInvoices || effective.readInvoices,
        }),
      );
    for (const group of unlisted)
      options.push(
        groupOption(organizationId, organizationName, group, {
          canRead: permissions.readInvoices,
        }),
      );
    return options;
  });
}

const groupOption = (
  organizationId: string,
  organizationName: string,
  group: { id: string; name: string },
  { canRead }: { canRead: boolean },
): CreateScopeOption => ({
  value: invoiceScopeValue({
    kind: "group",
    organizationId,
    groupId: group.id,
  }),
  label: group.name,
  organizationId,
  organizationName,
  groupId: group.id,
  canRead,
});

/** Create flag at organization level or effective through any group. */
export function hasCreateAccess({ memberships }: Memberships): boolean {
  return memberships.some(
    ({ permissions, groups }) =>
      permissions.createInvoices ||
      groups.some(({ effective }) => effective.createInvoices),
  );
}
