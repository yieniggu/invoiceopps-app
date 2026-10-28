import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import {
  lockGroupMembershipForUpdate,
  lockMembershipCascadeForUpdate,
  lockMembershipsForInvoiceWrite,
  lockOrganizationMembershipForUpdate,
} from "../../src/features/groups/locks.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;

type Tx = Prisma.TransactionClient;

interface Fixture {
  organizationId: string;
  groupA: string;
  groupB: string;
  userId: string;
  otherUserId: string;
}

async function createUser(label: string) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "User" ("id","name","rut") VALUES ($1,$2,$3)',
    [id, label, `rut-${id}`],
  );
  return id;
}

// Only columns that exist both before and after the permission-flag change;
// the flag columns rely on their defaults.
async function createFixture(): Promise<Fixture> {
  const organizationId = randomUUID();
  await client.query(
    'INSERT INTO "Organization" ("id","name","slug","updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP)',
    [organizationId, "locks-org", `locks-${organizationId}`],
  );
  const userId = await createUser("locks-user");
  const otherUserId = await createUser("locks-other");
  const groups: string[] = [];
  for (const label of ["a", "b"]) {
    const id = randomUUID();
    await client.query(
      'INSERT INTO "Group" ("id","organizationId","name") VALUES ($1,$2,$3)',
      [id, organizationId, `group-${label}-${id}`],
    );
    groups.push(id);
  }
  for (const member of [userId, otherUserId]) {
    await client.query(
      'INSERT INTO "OrganizationMembership" ("id","userId","organizationId","role") VALUES ($1,$2,$3,\'USER\')',
      [randomUUID(), member, organizationId],
    );
    for (const group of groups) {
      await client.query(
        'INSERT INTO "GroupMembership" ("id","groupId","userId","organizationId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), group, member, organizationId],
      );
    }
  }
  return {
    organizationId,
    groupA: groups[0]!,
    groupB: groups[1]!,
    userId,
    otherUserId,
  };
}

interface Holder {
  pid: number;
  release(): void;
  finished: Promise<void>;
}

// Opens a transaction on its own pooled connection, runs `work` (taking the
// locks under test) and keeps the transaction open until release() is called.
function hold(work: (tx: Tx) => Promise<unknown>): Promise<Holder> {
  return new Promise<Holder>((resolveReady, rejectReady) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = prisma
      .$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          await work(tx);
          resolveReady({ pid: rows[0]!.pid, release, finished });
          await gate;
        },
        { timeout: 30_000, maxWait: 10_000 },
      )
      .catch((error: unknown) => {
        // Surface setup/lock failures to the caller of hold() instead of
        // leaving an unhandled rejection behind.
        rejectReady(error);
      });
  });
}

interface Waiter {
  pid: Promise<number>;
  done: Promise<void>;
  settled(): boolean;
}

// Runs `work` in a second transaction and commits as soon as it returns.
function run(work: (tx: Tx) => Promise<unknown>): Waiter {
  let settled = false;
  let reportPid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    reportPid = resolve;
  });
  const done = prisma
    .$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        reportPid(rows[0]!.pid);
        await work(tx);
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .finally(() => {
      settled = true;
    });
  // Failures are asserted through `done`; avoid an unhandled-rejection report
  // when a test fails earlier.
  done.catch(() => undefined);
  return { pid, done, settled: () => settled };
}

// Deterministic: polls the lock graph until `waiterPid` is blocked by
// `holderPid`, with a bounded deadline instead of a fixed sleep.
async function waitUntilBlockedBy(
  waiterPid: number,
  holderPid: number,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await client.query(
      `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND $2::int = ANY(pg_blocking_pids(pid))`,
      [waiterPid, holderPid],
    );
    if (result.rowCount === 1) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Backend ${waiterPid} was not blocked by ${holderPid} after ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs = 5_000) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Operation did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectBlockedThenReleased(
  holder: Holder,
  waiter: Waiter,
): Promise<void> {
  await waitUntilBlockedBy(await waiter.pid, holder.pid);
  expect(waiter.settled()).toBe(false);
  holder.release();
  await holder.finished;
  await withinDeadline(waiter.done);
  expect(waiter.settled()).toBe(true);
}

let fixture: Fixture;

beforeAll(async () => {
  await client.connect();
  fixture = await createFixture();
});

afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

describe("RP0-22 membership lock API", () => {
  it("returns the locked membership rows, or null for a missing group scope", async () => {
    const result = await prisma.$transaction(async (tx) => {
      const withGroup = await lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      });
      const organizationOnly = await lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: null,
      });
      const stranger = await lockMembershipsForInvoiceWrite(tx, {
        userId: randomUUID(),
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      });
      return { withGroup, organizationOnly, stranger };
    });
    expect(result.withGroup.organizationMembership).not.toBeNull();
    expect(result.withGroup.groupMembership).not.toBeNull();
    expect(result.organizationOnly.organizationMembership).not.toBeNull();
    expect(result.organizationOnly.groupMembership).toBeNull();
    expect(result.stranger).toEqual({
      organizationMembership: null,
      groupMembership: null,
    });
  });
});

describe("RP0-22 invoice-write lock on the organization membership", () => {
  it("blocks a concurrent permission change until the invoice write commits", async () => {
    const holder = await hold((tx) =>
      lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: null,
      }),
    );
    const waiter = run((tx) =>
      lockOrganizationMembershipForUpdate(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
      }),
    );
    await expectBlockedThenReleased(holder, waiter);
  });

  it("lets two invoice writes share the same membership without blocking", async () => {
    const holder = await hold((tx) =>
      lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      }),
    );
    try {
      const second = run((tx) =>
        lockMembershipsForInvoiceWrite(tx, {
          userId: fixture.userId,
          organizationId: fixture.organizationId,
          groupId: fixture.groupA,
        }),
      );
      await withinDeadline(second.done);
    } finally {
      holder.release();
      await holder.finished;
    }
  });
});

describe("RP0-22 invoice-write lock on the group membership", () => {
  it("blocks a group permission change for the same membership", async () => {
    const holder = await hold((tx) =>
      lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      }),
    );
    const waiter = run((tx) =>
      lockGroupMembershipForUpdate(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      }),
    );
    await expectBlockedThenReleased(holder, waiter);
  });

  it("does not block a group permission change for another user's membership", async () => {
    const holder = await hold((tx) =>
      lockMembershipsForInvoiceWrite(tx, {
        userId: fixture.userId,
        organizationId: fixture.organizationId,
        groupId: fixture.groupA,
      }),
    );
    try {
      const other = run((tx) =>
        lockGroupMembershipForUpdate(tx, {
          userId: fixture.otherUserId,
          organizationId: fixture.organizationId,
          groupId: fixture.groupA,
        }),
      );
      await withinDeadline(other.done);
    } finally {
      holder.release();
      await holder.finished;
    }
  });
});

describe("RP0-22 cascade removal versus group permission change", () => {
  const cascade = (tx: Tx) =>
    lockMembershipCascadeForUpdate(tx, {
      userId: fixture.userId,
      organizationId: fixture.organizationId,
    });
  const groupChange = (tx: Tx, groupId: string) =>
    lockGroupMembershipForUpdate(tx, {
      userId: fixture.userId,
      organizationId: fixture.organizationId,
      groupId,
    });

  it("completes when the cascade holds first and the group change waits", async () => {
    const holder = await hold(cascade);
    const waiter = run((tx) => groupChange(tx, fixture.groupB));
    await expectBlockedThenReleased(holder, waiter);
  });

  it("completes when the group change holds first and the cascade waits", async () => {
    const holder = await hold((tx) => groupChange(tx, fixture.groupB));
    const waiter = run(cascade);
    await expectBlockedThenReleased(holder, waiter);
  });

  it("never deadlocks under repeated concurrent runs", async () => {
    for (let round = 0; round < 15; round += 1) {
      const results = await withinDeadline(
        Promise.allSettled([
          run(cascade).done,
          run((tx) => groupChange(tx, fixture.groupA)).done,
          run((tx) => groupChange(tx, fixture.groupB)).done,
          run(cascade).done,
        ]),
        20_000,
      );
      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }
    }
  });
});
