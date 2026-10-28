import { randomBytes } from "node:crypto";

import {
  type OrganizationRole,
  PlatformAdministrativeAuditEventType,
  type Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { hashPassword } from "../../auth.js";
import { ApiError } from "../../http/errors.js";
import {
  isUniqueViolation,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import {
  NO_INVOICE_PERMISSIONS,
  permissionsOf,
  type InvoicePermissions,
} from "../groups/invoice-permissions.js";
import { requireOrganizationAdmin } from "../orgs/authority.js";
import type {
  OrganizationUserDto,
  UserProvisionRequest,
  UserProvisionResponse,
} from "./types.js";

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** One organization membership (and its group memberships) to create. */
export interface MembershipGrant {
  organizationId: string;
  role: OrganizationRole;
  permissions: InvoicePermissions;
  groups: Array<{ groupId: string; permissions: InvoicePermissions }>;
}

export interface ProvisionedUser {
  user: { id: string; name: string; rut: string; mustChangePassword: boolean };
  memberships: MembershipGrant[];
  /** Present only when the server generated the password. */
  temporaryPassword: string | undefined;
}

export interface ProvisionUserInput {
  actorUserId: string;
  name: string;
  /** Canonical RUT as stored. */
  rut: string;
  memberships: MembershipGrant[];
  /** Admin-defined temporary password; when absent one is generated. */
  definedTemporaryPassword?: string;
  /**
   * Authority check, run before the (expensive) password hash and again inside
   * the transaction. It must throw an ApiError when the actor may not provision.
   */
  authorize: (database: Prisma.TransactionClient) => Promise<void>;
  /**
   * "organization": a single membership whose organization `authorize` already
   * proves to exist; the USER_PROVISIONED audit event carries its organization
   * and role. "platform": any number of organizations that are looked up, and
   * the USER_PROVISIONED event is untagged.
   */
  scope: "organization" | "platform";
}

/**
 * Creates a user with a temporary password and every requested organization
 * and group membership in one transaction: any failure persists nothing.
 * Intentional shared entry point of the organization-scoped and the platform
 * user creation.
 */
export async function provisionUserWithMemberships(
  prisma: PrismaClient,
  input: ProvisionUserInput,
): Promise<ProvisionedUser> {
  // Authority first: scrypt is expensive and must not run for outsiders.
  await input.authorize(prisma);
  const generatedPassword =
    input.definedTemporaryPassword === undefined
      ? randomBytes(24).toString("base64url")
      : undefined;
  const passwordHash = await hashPassword(
    input.definedTemporaryPassword ?? generatedPassword!,
  );

  // SERIALIZABLE and retried like every other membership writer: two
  // concurrent provisions of the same RUT end in one 201 and one 409, and a
  // lost race against a membership change is repeated, not surfaced as 500.
  return runSerializable(() =>
    prisma.$transaction(async (transaction) => {
      await input.authorize(transaction);
      await requireTargets(
        transaction,
        input.memberships,
        input.scope === "platform",
      );

      try {
        const user = await transaction.user.create({
          data: {
            name: input.name,
            rut: input.rut,
            passwordHash,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: new Date(
              Date.now() + TEMPORARY_PASSWORD_LIFETIME_MS,
            ),
          },
          select: { id: true, name: true, rut: true },
        });
        if (input.memberships.length > 0) {
          await transaction.organizationMembership.createMany({
            data: input.memberships.map((membership) => ({
              userId: user.id,
              organizationId: membership.organizationId,
              role: membership.role,
              ...membership.permissions,
            })),
          });
        }
        const groupRows = input.memberships.flatMap((membership) =>
          membership.groups.map((group) => ({
            userId: user.id,
            organizationId: membership.organizationId,
            groupId: group.groupId,
            ...group.permissions,
          })),
        );
        if (groupRows.length > 0) {
          await transaction.groupMembership.createMany({ data: groupRows });
        }

        const single =
          input.scope === "organization" ? input.memberships[0] : undefined;
        await transaction.platformAdministrativeAuditEvent.createMany({
          data: [
            {
              type: PlatformAdministrativeAuditEventType.USER_PROVISIONED,
              actorUserId: input.actorUserId,
              targetUserId: user.id,
              ...(single
                ? { organizationId: single.organizationId, role: single.role }
                : {}),
            },
            ...input.memberships.map((membership) => ({
              type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_CREATED,
              actorUserId: input.actorUserId,
              targetUserId: user.id,
              organizationId: membership.organizationId,
              role: membership.role,
              ...permissionsOf(membership.permissions),
            })),
            ...input.memberships.flatMap((membership) =>
              membership.groups.map((group) => ({
                type: PlatformAdministrativeAuditEventType.GROUP_MEMBERSHIP_CREATED,
                actorUserId: input.actorUserId,
                targetUserId: user.id,
                organizationId: membership.organizationId,
                groupId: group.groupId,
                ...permissionsOf(group.permissions),
              })),
            ),
          ],
        });

        return {
          user: { ...user, mustChangePassword: true },
          memberships: input.memberships,
          temporaryPassword: generatedPassword,
        };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "USER_CONFLICT", "User already exists");
        }
        throw error;
      }
    }, SERIALIZABLE),
  );
}

/** Every organization exists and every group belongs to its organization. */
async function requireTargets(
  transaction: Prisma.TransactionClient,
  memberships: MembershipGrant[],
  lookUpOrganizations: boolean,
) {
  const organizationIds = memberships.map(
    ({ organizationId }) => organizationId,
  );
  if (lookUpOrganizations && organizationIds.length > 0) {
    const found = await transaction.organization.count({
      where: { id: { in: organizationIds } },
    });
    if (found !== new Set(organizationIds).size) {
      throw new ApiError(404, "NOT_FOUND", "Organization not found");
    }
  }
  const groupIds = memberships.flatMap(({ groups }) =>
    groups.map(({ groupId }) => groupId),
  );
  if (groupIds.length > 0) {
    const groups = await transaction.group.findMany({
      where: { id: { in: groupIds } },
      select: { id: true, organizationId: true },
    });
    const organizationOf = new Map(
      groups.map((group) => [group.id, group.organizationId]),
    );
    for (const membership of memberships) {
      for (const group of membership.groups) {
        if (organizationOf.get(group.groupId) !== membership.organizationId) {
          throw new ApiError(404, "NOT_FOUND", "Group not found");
        }
      }
    }
  }
}

export interface UserService {
  listUsers(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationUserDto[]>;
  provisionUser(
    actorUserId: string,
    organizationId: string,
    input: UserProvisionRequest,
  ): Promise<UserProvisionResponse>;
}

export function createUserService(prisma: PrismaClient): UserService {
  return {
    async listUsers(actorUserId, organizationId) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      const memberships = await prisma.organizationMembership.findMany({
        where: { organizationId },
        orderBy: [
          { user: { name: "asc" } },
          { user: { rut: "asc" } },
          { userId: "asc" },
        ],
        select: {
          role: true,
          user: { select: { id: true, name: true, rut: true } },
        },
      });
      return memberships.map(({ role, user }) => ({ ...user, role }));
    },

    async provisionUser(actorUserId, organizationId, input) {
      const groups = (input.groups ?? []).map((group) => ({
        groupId: group.groupId,
        permissions: group.permissions ?? NO_INVOICE_PERMISSIONS,
      }));
      const provisioned = await provisionUserWithMemberships(prisma, {
        actorUserId,
        name: input.name,
        rut: input.rut,
        memberships: [
          {
            organizationId,
            role: input.role,
            permissions: input.permissions ?? NO_INVOICE_PERMISSIONS,
            groups,
          },
        ],
        authorize: (database) =>
          requireOrganizationAdmin(database, actorUserId, organizationId),
        scope: "organization",
        definedTemporaryPassword: input.temporaryPassword,
      });
      const [membership] = provisioned.memberships;
      return {
        user: provisioned.user,
        membership: {
          userId: provisioned.user.id,
          organizationId,
          role: membership!.role,
          permissions: membership!.permissions,
        },
        groups: membership!.groups,
        ...(provisioned.temporaryPassword === undefined
          ? {}
          : { temporaryPassword: provisioned.temporaryPassword }),
      };
    },
  };
}
