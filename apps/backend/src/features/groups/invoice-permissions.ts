import type { Prisma } from "../../generated/prisma/client.js";

// Invoice authorization rules derived from four independent flags stored per
// user on the organization membership and on the group membership. The role
// of a member (ADMIN included) and the platform administrator status never
// grant any of them, and no flag implies another one: delete-own and
// delete-others are evaluated against the creator of each invoice.

export interface InvoicePermissions {
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}

export const NO_INVOICE_PERMISSIONS: Readonly<InvoicePermissions> =
  Object.freeze({
    readInvoices: false,
    createInvoices: false,
    deleteOwnInvoices: false,
    deleteOthersInvoices: false,
  });

export type InvoiceScope = "organization" | "group";

export interface EffectivePermissionsInput {
  organizationEnabled: boolean;
  onboardingComplete: boolean;
  organizationMembership: { permissions: InvoicePermissions } | null;
  groupMembership: { permissions: InvoicePermissions } | null;
  scope: InvoiceScope;
}

/**
 * Group scope is the organization flags OR the group flags (the latter only
 * with a group membership); organization scope uses the organization flags
 * only. A disabled organization, a pending onboarding or a missing
 * organization membership grants nothing.
 */
export function resolveEffectivePermissions(
  input: EffectivePermissionsInput,
): InvoicePermissions {
  const { organizationMembership, groupMembership } = input;
  if (
    !input.organizationEnabled ||
    !input.onboardingComplete ||
    !organizationMembership
  ) {
    return { ...NO_INVOICE_PERMISSIONS };
  }
  const organization = organizationMembership.permissions;
  if (input.scope === "organization" || !groupMembership) {
    return pick(organization);
  }
  const group = groupMembership.permissions;
  return {
    readInvoices: organization.readInvoices || group.readInvoices,
    createInvoices: organization.createInvoices || group.createInvoices,
    deleteOwnInvoices:
      organization.deleteOwnInvoices || group.deleteOwnInvoices,
    deleteOthersInvoices:
      organization.deleteOthersInvoices || group.deleteOthersInvoices,
  };
}

function pick(flags: InvoicePermissions): InvoicePermissions {
  return {
    readInvoices: flags.readInvoices,
    createInvoices: flags.createInvoices,
    deleteOwnInvoices: flags.deleteOwnInvoices,
    deleteOthersInvoices: flags.deleteOthersInvoices,
  };
}

/** Own invoices need deleteOwn, anyone else's need deleteOthers. */
export function canDeleteInvoice(
  effective: InvoicePermissions,
  creatorUserId: string,
  actorUserId: string,
): boolean {
  return creatorUserId === actorUserId
    ? effective.deleteOwnInvoices
    : effective.deleteOthersInvoices;
}

export const PERMISSION_SELECT = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
} as const;

/** Extracts the four flags from any row that carries them. */
export function permissionsOf(row: InvoicePermissions): InvoicePermissions {
  return pick(row);
}

export interface ScopePermissions {
  /** Organization-level flags only (what the organization membership grants). */
  organization: InvoicePermissions;
  /** Effective flags in the requested scope (organization OR group flags). */
  effective: InvoicePermissions;
}

/**
 * Loads the organization, the onboarding state and both memberships once and
 * resolves both the organization-level and the effective permissions of the
 * requested scope. For `groupId: null` both are the same. The reads are
 * sequential on purpose: an interactive transaction owns one connection, so
 * concurrent reads would only queue.
 */
export async function loadScopePermissions(
  database: Prisma.TransactionClient,
  input: { userId: string; organizationId: string; groupId: string | null },
): Promise<ScopePermissions> {
  const organization = await database.organization.findUnique({
    where: { id: input.organizationId },
    select: { enabled: true },
  });
  const user = await database.user.findUnique({
    where: { id: input.userId },
    select: { mustChangePassword: true },
  });
  const organizationMembership =
    await database.organizationMembership.findUnique({
      where: {
        userId_organizationId: {
          userId: input.userId,
          organizationId: input.organizationId,
        },
      },
      select: PERMISSION_SELECT,
    });
  const groupMembership =
    input.groupId === null
      ? null
      : await database.groupMembership.findFirst({
          where: {
            userId: input.userId,
            organizationId: input.organizationId,
            groupId: input.groupId,
          },
          select: PERMISSION_SELECT,
        });

  const base = {
    organizationEnabled: organization?.enabled === true,
    onboardingComplete: user !== null && !user.mustChangePassword,
    organizationMembership: organizationMembership && {
      permissions: pick(organizationMembership),
    },
  };
  const organizationScope = resolveEffectivePermissions({
    ...base,
    groupMembership: null,
    scope: "organization",
  });
  if (input.groupId === null) {
    return { organization: organizationScope, effective: organizationScope };
  }
  return {
    organization: organizationScope,
    effective: resolveEffectivePermissions({
      ...base,
      groupMembership: groupMembership && {
        permissions: pick(groupMembership),
      },
      scope: "group",
    }),
  };
}

/**
 * Single source of effective permissions for profile, invoices and tokens:
 * loads the organization, the onboarding state and both memberships, then
 * calls the pure resolver. It never looks at roles or platform status.
 */
export async function loadEffectivePermissions(
  database: Prisma.TransactionClient,
  input: { userId: string; organizationId: string; groupId: string | null },
): Promise<InvoicePermissions> {
  return (await loadScopePermissions(database, input)).effective;
}
