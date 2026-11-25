import { isUuid } from "../../lib/uuid";
import type { Profile } from "../auth/types";
import type { InvoicePermissions } from "../permissions/types";
import type { InvoiceScope } from "./types";

// Pure mapping between the profile, the scopes the inbox may offer and the
// URL. The profile only decides what the screen offers; the API stays the
// authority and answers 403/404 to anything else.

type Memberships = Pick<Profile, "memberships"> &
  Partial<Pick<Profile, "isPlatformAdministrator">>;

/** An organization as the inbox lists it (id and display name only). */
export interface OrganizationChoice {
  id: string;
  name: string;
}

export interface InvoiceScopeOption {
  /** Stable, unique `<option value>`. */
  value: string;
  /** Short text of the `<option>`; its organization is the group's label. */
  label: string;
  /** The scope the option selects (organization, ungrouped or one group). */
  context: InvoiceScope;
  organizationId: string;
  organizationName: string;
  /** Scope as the object of «en», e.g. «el grupo Compras». */
  place: string;
}

/** Groups of each organization (by id) as the organization lists them. */
export type OrganizationGroups = ReadonlyMap<
  string,
  ReadonlyArray<{ id: string; name: string }>
>;

export function invoiceScopeValue(scope: InvoiceScope): string {
  return scope.kind === "group"
    ? `group:${scope.organizationId}:${scope.groupId}`
    : `${scope.kind}:${scope.organizationId}`;
}

/**
 * Whether the person reads every invoice of the organization: the platform
 * administrator (any organization) and an organization ADMIN, besides
 * organization-level `readInvoices`. The API stays the authority.
 */
function readsWholeOrganization(
  profile: Memberships,
  membership: Memberships["memberships"][number] | undefined,
): boolean {
  return (
    profile.isPlatformAdministrator === true ||
    membership?.role === "ADMIN" ||
    membership?.permissions.readInvoices === true
  );
}

/** Whether the person reads the whole organization (its groups are then listed). */
export function readsWholeOrganizationById(
  profile: Memberships,
  organizationId: string,
): boolean {
  return readsWholeOrganization(
    profile,
    profile.memberships.find(
      ({ organization }) => organization.id === organizationId,
    ),
  );
}

/**
 * Scopes the person can read. Organizations come from the platform directory
 * for the platform administrator (`platformOrganizations`, every organization)
 * and from the memberships otherwise; an organization appears only when it has
 * at least one scope. Per organization: «Todos» and «Sin grupo asignado» for
 * an organization-wide reader (platform administrator, ADMIN or organization
 * read) and then every group: all the groups the organization lists
 * (`organizationGroups`) for that reader, plus the profile's groups with
 * effective read, deduplicated by id.
 */
export function invoiceScopeOptions(
  profile: Memberships,
  organizationGroups: OrganizationGroups = new Map(),
  platformOrganizations?: readonly OrganizationChoice[],
): InvoiceScopeOption[] {
  const { memberships } = profile;
  const byId = new Map(
    memberships.map((membership) => [membership.organization.id, membership]),
  );
  const organizations: OrganizationChoice[] =
    profile.isPlatformAdministrator && platformOrganizations
      ? [
          ...platformOrganizations,
          ...memberships
            .map(({ organization }) => organization)
            .filter(
              ({ id }) => !platformOrganizations.some((own) => own.id === id),
            ),
        ]
      : memberships.map(({ organization }) => organization);
  return organizations.flatMap(
    ({ id: organizationId, name: organizationName }) => {
      const membership = byId.get(organizationId);
      const option = (
        scope: InvoiceScope,
        label: string,
        place: string,
      ): InvoiceScopeOption => ({
        value: invoiceScopeValue(scope),
        label,
        context: scope,
        organizationId,
        organizationName,
        place,
      });
      const options: InvoiceScopeOption[] = [];
      const wholeOrganization = readsWholeOrganization(profile, membership);
      if (wholeOrganization)
        options.push(
          option(
            { kind: "organization", organizationId },
            "Todos",
            organizationName,
          ),
          option(
            { kind: "ungrouped", organizationId },
            "Sin grupo asignado",
            `${organizationName} sin grupo asignado`,
          ),
        );
      const readable = (membership?.groups ?? [])
        .filter(({ effective }) => effective.readInvoices)
        .map(({ group }) => group);
      const known = new Set(readable.map(({ id }) => id));
      const unlisted = wholeOrganization
        ? (organizationGroups.get(organizationId) ?? []).filter(
            ({ id }) => !known.has(id),
          )
        : [];
      for (const group of [...readable, ...unlisted])
        options.push(
          option(
            { kind: "group", organizationId, groupId: group.id },
            group.name,
            `el grupo ${group.name}`,
          ),
        );
      return options;
    },
  );
}

/** Organizations of the options, in order, for the «Organización» select. */
export function invoiceOrganizationChoices(
  options: readonly InvoiceScopeOption[],
): OrganizationChoice[] {
  const seen = new Map<string, OrganizationChoice>();
  for (const { organizationId, organizationName } of options)
    if (!seen.has(organizationId))
      seen.set(organizationId, { id: organizationId, name: organizationName });
  return [...seen.values()];
}

/** Options of one organization, for the «Grupo» select. */
export function invoiceGroupChoices(
  options: readonly InvoiceScopeOption[],
  organizationId: string,
): InvoiceScopeOption[] {
  return options.filter((option) => option.organizationId === organizationId);
}

/**
 * The scope that opens when the organization changes: «Todos» when the person
 * reads the whole organization, else its first readable group.
 */
export function firstScopeOfOrganization(
  options: readonly InvoiceScopeOption[],
  organizationId: string,
): InvoiceScopeOption | undefined {
  const own = invoiceGroupChoices(options, organizationId);
  return own.find(({ context }) => context.kind === "organization") ?? own[0];
}

/** The whole of the first organization with organization read, else the first group. */
export function defaultInvoiceScopeOption(
  options: readonly InvoiceScopeOption[],
): InvoiceScopeOption | undefined {
  return (
    options.find(({ context }) => context.kind === "organization") ?? options[0]
  );
}

/** Scope written in the URL, if it is well formed and not contradictory. */
export function scopeFromSearch(
  search: URLSearchParams,
): InvoiceScope | undefined {
  const organizationId = search.get("organizationId");
  if (organizationId === null || !isUuid(organizationId)) return undefined;
  const groupId = search.get("groupId");
  const ungrouped = search.get("ungrouped") === "true";
  if (groupId !== null) {
    return isUuid(groupId) && !ungrouped
      ? { kind: "group", organizationId, groupId }
      : undefined;
  }
  return ungrouped
    ? { kind: "ungrouped", organizationId }
    : { kind: "organization", organizationId };
}

/** `organizationId` plus `groupId` or `ungrouped=true`, as URL entries. */
export function scopeToSearch(scope: InvoiceScope): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["organizationId", scope.organizationId],
  ];
  if (scope.kind === "group") entries.push(["groupId", scope.groupId]);
  if (scope.kind === "ungrouped") entries.push(["ungrouped", "true"]);
  return entries;
}

/**
 * The option the URL points at, when the person may read it; otherwise the
 * default (also for a forged or stale URL). Undefined only without options.
 */
export function resolveInvoiceScope(
  options: readonly InvoiceScopeOption[],
  search: URLSearchParams,
): InvoiceScopeOption | undefined {
  const requested = scopeFromSearch(search);
  const match =
    requested &&
    options.find(({ value }) => value === invoiceScopeValue(requested));
  return match ?? defaultInvoiceScopeOption(options);
}

/**
 * Whether the «Facturas» entry exists: the platform administrator and any
 * organization ADMIN (they read every invoice of their organizations), or any
 * invoice flag at organization level or effective through a group.
 */
export function hasInvoiceAccess(profile: Memberships): boolean {
  if (profile.isPlatformAdministrator) return true;
  const any = (flags: InvoicePermissions) => Object.values(flags).some(Boolean);
  return profile.memberships.some(
    ({ role, permissions, groups }) =>
      role === "ADMIN" ||
      any(permissions) ||
      groups.some(({ effective }) => any(effective)),
  );
}
