import {
  PlatformAdministrativeAuditEventType,
  type Prisma,
} from "../../generated/prisma/client.js";
import type { InvoicePermissions } from "./invoice-permissions.js";

// Durable audit of membership changes. Every helper writes inside the
// transaction of the change itself (all or nothing), one row per affected
// member. Rows carry identifiers and the new invoice flags only: no names,
// RUTs or secrets. `actorIsTarget` makes a self-grant visible: an actor may
// assign invoice permissions to themselves (platform administrator and ADMIN
// roles grant none implicitly), and that is always recorded.

interface MembershipAuditScope {
  actorUserId: string;
  organizationId: string;
  /** Set for group memberships; null for organization memberships. */
  groupId?: string | null;
}

function flagsOf(permissions: InvoicePermissions) {
  return {
    readInvoices: permissions.readInvoices,
    createInvoices: permissions.createInvoices,
    deleteOwnInvoices: permissions.deleteOwnInvoices,
    deleteOthersInvoices: permissions.deleteOthersInvoices,
  };
}

function baseRow(scope: MembershipAuditScope, targetUserId: string) {
  return {
    actorUserId: scope.actorUserId,
    targetUserId,
    organizationId: scope.organizationId,
    groupId: scope.groupId ?? null,
    actorIsTarget: scope.actorUserId === targetUserId,
  };
}

/** The permissions of existing memberships were replaced. */
export async function auditPermissionsChanged(
  transaction: Prisma.TransactionClient,
  scope: MembershipAuditScope,
  targets: ReadonlyArray<{ userId: string; permissions: InvoicePermissions }>,
) {
  await transaction.platformAdministrativeAuditEvent.createMany({
    data: targets.map(({ userId, permissions }) => ({
      type: PlatformAdministrativeAuditEventType.MEMBERSHIP_PERMISSIONS_CHANGED,
      ...baseRow(scope, userId),
      ...flagsOf(permissions),
    })),
  });
}

/** Group memberships were created with their initial permissions. */
export async function auditGroupMembershipsCreated(
  transaction: Prisma.TransactionClient,
  scope: MembershipAuditScope & { groupId: string },
  targets: ReadonlyArray<{ userId: string; permissions: InvoicePermissions }>,
) {
  await transaction.platformAdministrativeAuditEvent.createMany({
    data: targets.map(({ userId, permissions }) => ({
      type: PlatformAdministrativeAuditEventType.GROUP_MEMBERSHIP_CREATED,
      ...baseRow(scope, userId),
      ...flagsOf(permissions),
    })),
  });
}

/** Group memberships were removed (directly or by an organization removal). */
export async function auditGroupMembershipsRemoved(
  transaction: Prisma.TransactionClient,
  scope: MembershipAuditScope,
  targets: ReadonlyArray<{ userId: string; groupId: string }>,
) {
  await transaction.platformAdministrativeAuditEvent.createMany({
    data: targets.map(({ userId, groupId }) => ({
      type: PlatformAdministrativeAuditEventType.GROUP_MEMBERSHIP_REMOVED,
      ...baseRow({ ...scope, groupId }, userId),
    })),
  });
}
