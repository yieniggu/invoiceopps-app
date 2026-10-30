import { isUuid } from "../../lib/uuid";
import type { Profile } from "../auth/types";
import type { InvoicePermissions } from "../permissions/types";
import type { InvoiceScope } from "./types";

// Pure mapping between the profile, the scopes the inbox may offer and the
// URL. The profile only decides what the screen offers; the API stays the
// authority and answers 403/404 to anything else.

type Memberships = Pick<Profile, "memberships">;

export interface InvoiceScopeOption {
  /** Stable, unique `<option value>`. */
  value: string;
  /** Short text of the `<option>`; its organization is the group's label. */
  label: string;
  /** The scope the option selects (organization, ungrouped or one group). */
  context: InvoiceScope;
  organizationId: string;
  organizationName: string;
  /** Scope in words for a subtitle, e.g. «Grupo Compras · Acme». */
  summary: string;
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
 * Scopes the person can read, in profile order: per organization the whole
 * organization and the ungrouped scope (organization read) and then every
 * group with effective read. With organization read, the groups the
 * organization lists (`organizationGroups`) join the profile's, deduplicated
 * by id: the profile only lists member groups. The selector groups the
 * options by `organizationName`.
 */
export function invoiceScopeOptions(
  { memberships }: Memberships,
  organizationGroups: OrganizationGroups = new Map(),
): InvoiceScopeOption[] {
  return memberships.flatMap(({ organization, permissions, groups }) => {
    const { id: organizationId, name: organizationName } = organization;
    const option = (
      scope: InvoiceScope,
      label: string,
      summary: string,
      place: string,
    ): InvoiceScopeOption => ({
      value: invoiceScopeValue(scope),
      label,
      context: scope,
      organizationId,
      organizationName,
      summary: `${summary} · ${organizationName}`,
      place,
    });
    const options: InvoiceScopeOption[] = [];
    if (permissions.readInvoices)
      options.push(
        option(
          { kind: "organization", organizationId },
          "Toda la organización",
          "Toda la organización",
          organizationName,
        ),
        option(
          { kind: "ungrouped", organizationId },
          "Sin grupo asignado",
          "Sin grupo asignado",
          `${organizationName} sin grupo asignado`,
        ),
      );
    const readable = groups
      .filter(({ effective }) => effective.readInvoices)
      .map(({ group }) => group);
    const known = new Set(readable.map(({ id }) => id));
    const unlisted = permissions.readInvoices
      ? (organizationGroups.get(organizationId) ?? []).filter(
          ({ id }) => !known.has(id),
        )
      : [];
    for (const group of [...readable, ...unlisted])
      options.push(
        option(
          { kind: "group", organizationId, groupId: group.id },
          group.name,
          `Grupo ${group.name}`,
          `el grupo ${group.name}`,
        ),
      );
    return options;
  });
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
 * Any invoice flag, at organization level or effective through a group, in
 * any membership. Not derived from the ADMIN role: administering an
 * organization is not a permission over its invoices.
 */
export function hasInvoiceAccess({ memberships }: Memberships): boolean {
  const any = (flags: InvoicePermissions) => Object.values(flags).some(Boolean);
  return memberships.some(
    ({ permissions, groups }) =>
      any(permissions) || groups.some(({ effective }) => any(effective)),
  );
}
