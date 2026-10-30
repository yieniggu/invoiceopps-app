import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { formatRut } from "../../rut.js";
import { pageWindow } from "../../pagination.js";
import { runSerializable } from "../../transactions.js";
import { userSearchCondition } from "../../user-search.js";
import { isRecentlyActive } from "../auth/services.js";
import {
  PERMISSION_SELECT,
  permissionsOf,
} from "../groups/invoice-permissions.js";
import { requirePlatformAdministrator } from "../orgs/authority.js";
import { notFound } from "./targets.js";
import type {
  AdminUserDetailResponse,
  AdminUserListQuery,
  AdminUserListResponse,
} from "./types.js";

export const detailUserSelect = {
  id: true,
  name: true,
  rut: true,
  email: true,
  disabledAt: true,
  lastActiveAt: true,
  mustChangePassword: true,
  platformAdministrator: { select: { id: true } },
} as const;

type DetailUserRow = Prisma.UserGetPayload<{ select: typeof detailUserSelect }>;

export function toDetailUser(row: DetailUserRow) {
  return {
    id: row.id,
    name: row.name,
    rut: formatRut(row.rut),
    email: row.email,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    recentlyActive: isRecentlyActive(row.lastActiveAt, row.disabledAt),
    mustChangePassword: row.mustChangePassword,
    isPlatformAdministrator: row.platformAdministrator !== null,
  };
}

function listWhere(query: AdminUserListQuery): Prisma.UserWhereInput {
  const conditions: Prisma.UserWhereInput[] = [];
  if (query.status === "active") conditions.push({ disabledAt: null });
  if (query.status === "disabled")
    conditions.push({ disabledAt: { not: null } });
  if (query.search !== undefined)
    conditions.push(userSearchCondition(query.search));
  return { AND: conditions };
}

export async function listUsers(
  prisma: PrismaClient,
  actorUserId: string,
  query: AdminUserListQuery,
): Promise<AdminUserListResponse> {
  // One snapshot for the count and the page, so total matches the rows.
  return runSerializable(
    () =>
      prisma.$transaction(
        async (transaction) => {
          await requirePlatformAdministrator(transaction, actorUserId);
          const where = listWhere(query);
          const total = await transaction.user.count({ where });
          const rows = await transaction.user.findMany({
            where,
            orderBy: [{ name: "asc" }, { id: "asc" }],
            ...pageWindow(query),
            select: {
              id: true,
              name: true,
              rut: true,
              disabledAt: true,
              lastActiveAt: true,
            },
          });
          return {
            users: rows.map((row) => ({
              id: row.id,
              name: row.name,
              rut: formatRut(row.rut),
              disabledAt: row.disabledAt?.toISOString() ?? null,
              recentlyActive: isRecentlyActive(
                row.lastActiveAt,
                row.disabledAt,
              ),
            })),
            page: query.page,
            pageSize: query.pageSize,
            total,
          };
        },
        { isolationLevel: "RepeatableRead" },
      ),
    undefined,
    "admin_user_list",
  );
}

export async function getUser(
  prisma: PrismaClient,
  actorUserId: string,
  targetUserId: string,
): Promise<AdminUserDetailResponse> {
  return runSerializable(
    () =>
      prisma.$transaction(
        async (transaction) => {
          await requirePlatformAdministrator(transaction, actorUserId);
          const row = await transaction.user.findUnique({
            where: { id: targetUserId },
            select: {
              ...detailUserSelect,
              memberships: {
                orderBy: [
                  { organization: { name: "asc" } },
                  { organizationId: "asc" },
                ],
                select: {
                  role: true,
                  ...PERMISSION_SELECT,
                  organization: {
                    select: { id: true, name: true, slug: true },
                  },
                  groupMemberships: {
                    orderBy: [{ group: { name: "asc" } }, { groupId: "asc" }],
                    select: {
                      ...PERMISSION_SELECT,
                      group: { select: { id: true, name: true } },
                    },
                  },
                },
              },
            },
          });
          if (!row) throw notFound();
          const { memberships, ...user } = row;
          return {
            user: toDetailUser(user),
            memberships: memberships.map((membership) => ({
              organization: membership.organization,
              role: membership.role,
              permissions: permissionsOf(membership),
              groups: membership.groupMemberships.map((groupMembership) => ({
                group: groupMembership.group,
                permissions: permissionsOf(groupMembership),
              })),
            })),
          };
        },
        { isolationLevel: "RepeatableRead" },
      ),
    undefined,
    "admin_user_get",
  );
}
