import { randomInt, randomUUID } from "node:crypto";
import type { Client } from "pg";
import request from "../support/request.js";

import type { Express } from "express";
import { hashPassword, type AuthService } from "../../src/auth.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { formatRut } from "../../src/rut.js";

export const PASSWORD = "correct-horse-battery";
export const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };

export const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
export const ALL_FLAGS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};

export function randomRut() {
  const body = String(randomInt(10_000_000, 99_999_999));
  let sum = 0;
  let multiplier = 2;
  for (const digit of [...body].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  const dv =
    remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return `${body}${dv}`;
}

type Flags = typeof ALL_FLAGS;

/** Helpers shared by the PostgreSQL suites of the membership-permission model. */
export function membershipFixtures(deps: {
  prisma: PrismaClient;
  client: Client;
  auth: AuthService;
  app: Express;
  url: string;
}) {
  const { prisma, client, auth, app } = deps;

  async function makeUser(name = "Test User") {
    const rut = randomRut();
    const user = await prisma.user.create({
      data: { name, rut, passwordHash: await hashPassword(PASSWORD) },
      select: { id: true, rut: true },
    });
    return { id: user.id, rut: formatRut(user.rut), rawRut: user.rut };
  }

  const makeOrg = (label = "org") =>
    prisma.organization.create({
      data: { name: `Org ${label}`, slug: `${label}-${randomUUID()}` },
    });

  const join = (
    userId: string,
    organizationId: string,
    role: "ADMIN" | "USER",
    flags: Partial<Flags> = {},
  ) =>
    prisma.organizationMembership.create({
      data: { userId, organizationId, role, ...flags },
    });

  const makeGroup = (organizationId: string, name = "Group") =>
    prisma.group.create({ data: { organizationId, name } });

  const addToGroup = (
    groupId: string,
    userId: string,
    organizationId: string,
    flags: Partial<Flags> = {},
  ) =>
    prisma.groupMembership.create({
      data: { groupId, userId, organizationId, ...flags },
    });

  async function cookieFor(user: { rut: string }) {
    const { sessionToken } = await auth.login({
      rut: user.rut,
      password: PASSWORD,
    });
    return `invoiceops_session=${sessionToken}`;
  }

  function call(
    method: "get" | "post" | "patch" | "put" | "delete",
    path: string,
    cookie: string | undefined,
    body?: unknown,
  ) {
    let test = request(app)[method](`/api/v1${path}`).set(SAME_ORIGIN);
    if (cookie) test = test.set("Cookie", cookie);
    return body === undefined ? test : test.send(body as object);
  }

  // The PlatformAdministrator singleton cannot be deleted by design (trigger);
  // the suite that uses this owns the singleton of the dedicated test database.
  async function designatePlatformAdministrator(userId: string) {
    await client.query("BEGIN");
    try {
      await client.query(
        'ALTER TABLE "PlatformAdministrator" DISABLE TRIGGER prevent_platform_administrator_delete',
      );
      await client.query('DELETE FROM "PlatformAdministrator"');
      await client.query(
        'ALTER TABLE "PlatformAdministrator" ENABLE TRIGGER prevent_platform_administrator_delete',
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await prisma.platformAdministrator.create({ data: { id: 1, userId } });
  }

  // Waits (bounded) until a backend is blocked on a row lock running a
  // statement that matches `pattern`; the deterministic ordering signal, no
  // sleep is used as an assertion.
  async function waitUntilBlocked(pattern: string) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await client.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
           AND query ILIKE $1`,
        [pattern],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no backend blocked on a lock matching ${pattern}`);
  }

  async function scenario() {
    const org = await makeOrg("grp");
    const admin = await makeUser("Ada Admin");
    const member = await makeUser("Uma User");
    const outsider = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    await join(member.id, org.id, "USER");
    const group = await makeGroup(org.id, "Finance");
    return { org, admin, member, outsider, group };
  }

  return {
    makeUser,
    makeOrg,
    join,
    makeGroup,
    addToGroup,
    cookieFor,
    call,
    designatePlatformAdministrator,
    waitUntilBlocked,
    scenario,
  };
}

export type TestUser = Awaited<
  ReturnType<ReturnType<typeof membershipFixtures>["makeUser"]>
>;
export type Scenario = Awaited<
  ReturnType<ReturnType<typeof membershipFixtures>["scenario"]>
>;
