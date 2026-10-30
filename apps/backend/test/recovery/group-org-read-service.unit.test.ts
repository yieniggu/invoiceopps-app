import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  getUser,
  listUsers,
} from "../../src/features/admin-users/directory.js";
import { createGroupService } from "../../src/features/groups/services.js";
import { createOrganizationService } from "../../src/features/orgs/services.js";
import { createUserService } from "../../src/features/users/services.js";

// CR-371 / CR-393: one policy for snapshot reads. A transaction timeout
// (Prisma P2028) on any RepeatableRead read answers the same retryable 503 as
// the invoice reads and the writes, never an unexpected 500; a lost race
// (P2034) is retried and then succeeds.

const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const PAGE = { page: 1, pageSize: 20 };

function failure(code: string) {
  return Object.assign(new Error("failure"), { code });
}

function prismaFailingWith(code: string) {
  const transaction = vi.fn().mockRejectedValue(failure(code));
  return {
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    transaction,
  };
}

function prismaRecovering(result: unknown) {
  const transaction = vi
    .fn()
    .mockRejectedValueOnce(failure("P2034"))
    .mockResolvedValue(result);
  return {
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    transaction,
  };
}

interface ReadCase {
  name: string;
  operation: string;
  /** What the transaction resolves with (already the service result). */
  result: unknown;
  run: (prisma: PrismaClient) => Promise<unknown>;
}

const READS: ReadCase[] = [
  {
    name: "listGroups",
    operation: "group_list",
    result: [],
    run: (prisma) => createGroupService(prisma).listGroups("user-1", ORG),
  },
  {
    name: "group listMemberships",
    operation: "group_memberships_list",
    result: { memberships: [], ...PAGE, total: 0 },
    run: (prisma) =>
      createGroupService(prisma).listMemberships("user-1", ORG, GROUP, PAGE),
  },
  {
    name: "organization listUsers",
    operation: "user_list",
    result: { users: [], ...PAGE, total: 0 },
    run: (prisma) => createUserService(prisma).listUsers("user-1", ORG, PAGE),
  },
  {
    name: "organization getUser",
    operation: "user_get",
    result: { user: {}, sharedOrganizations: [] },
    run: (prisma) => createUserService(prisma).getUser("user-1", "user-2"),
  },
  {
    name: "admin listUsers",
    operation: "admin_user_list",
    result: { users: [], ...PAGE, total: 0 },
    run: (prisma) =>
      listUsers(prisma, "user-1", { ...PAGE, status: "all" } as never),
  },
  {
    name: "admin getUser",
    operation: "admin_user_get",
    result: { user: {}, memberships: [] },
    run: (prisma) => getUser(prisma, "user-1", "user-2"),
  },
  {
    name: "listOrganizations",
    operation: "organization_list",
    result: { organizations: [], ...PAGE, total: 0 },
    run: (prisma) =>
      createOrganizationService(prisma).listOrganizations("user-1", PAGE),
  },
  {
    name: "listMembers",
    operation: "organization_members_list",
    result: { members: [], ...PAGE, total: 0 },
    run: (prisma) =>
      createOrganizationService(prisma).listMembers("user-1", ORG, PAGE),
  },
  {
    name: "organization listMemberships",
    operation: "organization_memberships_list",
    result: { memberships: [], ...PAGE, total: 0 },
    run: (prisma) =>
      createOrganizationService(prisma).listMemberships("user-1", ORG, PAGE),
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapshot reads under runSerializable (CR-371, CR-393)", () => {
  it.each(READS)(
    "maps a $name transaction timeout to the retryable 503",
    async ({ run, operation }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { prisma, transaction } = prismaFailingWith("P2028");

      const outcome = await run(prisma).catch((error: unknown) => error);

      expect(outcome).toMatchObject({
        status: 503,
        code: "RETRYABLE_CONFLICT",
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        event: "transaction.conflict",
        operation,
        reason: "timeout",
      });
    },
  );

  it.each(READS)(
    "retries a $name after a lost race and then succeeds",
    async ({ run, operation, result }) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { prisma, transaction } = prismaRecovering(result);

      await expect(run(prisma)).resolves.toEqual(result);

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        event: "transaction.conflict",
        operation,
        outcome: "retry",
        reason: "conflict",
      });
    },
  );

  it("maps a getOrganization transaction timeout to the retryable 503", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, transaction } = prismaFailingWith("P2028");

    const outcome = await createOrganizationService(prisma)
      .getOrganization("user-1", ORG)
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      event: "transaction.conflict",
      operation: "organization_get",
      reason: "timeout",
    });
  });

  it("retries a getOrganization after a lost race and then succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, transaction } = prismaRecovering({
      id: ORG,
      name: "Org",
      _count: { memberships: 2, groups: 1 },
    });

    const result = await createOrganizationService(prisma).getOrganization(
      "user-1",
      ORG,
    );

    expect(result.summary).toEqual({ memberCount: 2, groupCount: 1 });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      operation: "organization_get",
      outcome: "retry",
    });
  });
});
