import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService, hashPassword } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { createInvoiceService } from "../../src/invoices.js";
import {
  BootstrapRejectedError,
  createBootstrapService,
} from "../../src/features/auth/bootstrap-service.js";
import { formatRut } from "../../src/rut.js";

const url = process.env.RECOVERY_TEST_DATABASE_URL;
if (!url) {
  throw new Error("RECOVERY_TEST_DATABASE_URL must be configured");
}
if (new URL(url).pathname !== "/invoiceops_recovery_test") {
  throw new Error(
    "RECOVERY_TEST_DATABASE_URL must target invoiceops_recovery_test",
  );
}

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const PASSWORD = "temporary-secret-123";

// The PlatformAdministrator singleton cannot be deleted by design (trigger).
// This file owns the singleton of the dedicated test database, so each test
// starts from "no designation" by disabling the guard on the test DB only.
async function clearDesignation() {
  // One transaction: the guard is only disabled inside it, so a failure can
  // never leave the trigger off for later tests (ALTER TABLE is transactional).
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
}

// Resolves once another backend of this database is blocked on a lock, i.e.
// the competing transaction is provably waiting for the one holding the hook.
// PostgreSQL files run one at a time (--no-file-parallelism), so the waiter
// can only come from this file. Bounded: fails with a clear error.
async function waitForBlockedBackend(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const waiting = await client.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()`,
    );
    if ((waiting.rows[0].n as number) >= 1) return;
    if (Date.now() > deadline) {
      throw new Error(
        `No competing transaction blocked on a lock within ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function randomRut() {
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

async function counts(rut: string) {
  const users = await client.query('SELECT id FROM "User" WHERE rut = $1', [
    rut,
  ]);
  const ids = users.rows.map((row) => row.id as string);
  const admins = await client.query(
    'SELECT count(*)::int AS n FROM "PlatformAdministrator"',
  );
  const audit = await client.query(
    `SELECT count(*)::int AS n FROM "PlatformAdministrativeAuditEvent"
     WHERE "targetUserId" = ANY($1::text[])
       AND type = 'PLATFORM_ADMINISTRATOR_BOOTSTRAPPED'`,
    [ids],
  );
  return {
    users: ids.length,
    admins: admins.rows[0].n as number,
    audit: audit.rows[0].n as number,
  };
}

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});
beforeEach(clearDesignation);

describe("RP0-03 bootstrap against PostgreSQL", () => {
  it("creates a usable temporary login and one designation with an audit event", async () => {
    const rut = randomRut();
    const service = createBootstrapService(prisma);

    const result = await service.bootstrap({
      name: "Ada Lovelace",
      rut: formatRut(rut),
      password: PASSWORD,
    });

    expect(result.outcome).toBe("created");
    const user = (
      await client.query(
        'SELECT "passwordHash","mustChangePassword","temporaryPasswordExpiresAt" FROM "User" WHERE rut = $1',
        [rut],
      )
    ).rows[0];
    expect(user.passwordHash).toMatch(/^scrypt\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.mustChangePassword).toBe(true);
    // timestamp(3) has no zone: read it through Prisma, which uses UTC.
    const stored = await prisma.user.findUniqueOrThrow({
      where: { rut },
      select: { temporaryPasswordExpiresAt: true },
    });
    const hours =
      (stored.temporaryPasswordExpiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
    expect(await counts(rut)).toEqual({ users: 1, admins: 1, audit: 1 });
  });

  it("is a no-op for the same RUT: no password, flag or privilege change", async () => {
    const rut = randomRut();
    const service = createBootstrapService(prisma);
    await service.bootstrap({ name: "Ada", rut, password: PASSWORD });
    const before = (
      await client.query('SELECT * FROM "User" WHERE rut = $1', [rut])
    ).rows[0];

    const again = await service.bootstrap({
      name: "Someone Else",
      rut,
      password: "another-secret-456",
    });

    expect(again.outcome).toBe("unchanged");
    const after = (
      await client.query('SELECT * FROM "User" WHERE rut = $1', [rut])
    ).rows[0];
    expect(after).toEqual(before);
    expect(await counts(rut)).toEqual({ users: 1, admins: 1, audit: 1 });
  });

  it("rejects a different RUT while the singleton exists and creates nothing", async () => {
    const holder = randomRut();
    const other = randomRut();
    const service = createBootstrapService(prisma);
    await service.bootstrap({ name: "Ada", rut: holder, password: PASSWORD });

    await expect(
      service.bootstrap({ name: "Grace", rut: other, password: PASSWORD }),
    ).rejects.toBeInstanceOf(BootstrapRejectedError);

    expect((await counts(other)).users).toBe(0);
    expect((await counts(holder)).admins).toBe(1);
  });

  it("serializes two forced-overlap runs into one user, one designation and an unchanged loser", async () => {
    const rut = randomRut();
    const input = { name: "Ada", rut, password: PASSWORD };
    let holder = true;
    // The first run to create the user waits (transaction open, row
    // uncommitted) until the second run is blocked on that very row.
    const service = createBootstrapService(prisma, {
      afterUserCreated: async () => {
        if (!holder) return;
        holder = false;
        await waitForBlockedBackend();
      },
    });

    const outcomes = await Promise.all([
      service.bootstrap(input),
      service.bootstrap(input),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "created",
      "unchanged",
    ]);
    expect(outcomes[0].userId).toBe(outcomes[1].userId);
    expect(await counts(rut)).toEqual({ users: 1, admins: 1, audit: 1 });
  });

  it("leaves nothing partial when the transaction fails after creating the user", async () => {
    const rut = randomRut();
    const service = createBootstrapService(prisma, {
      afterUserCreated: async () => {
        throw new Error("forced failure");
      },
    });

    await expect(
      service.bootstrap({ name: "Ada", rut, password: PASSWORD }),
    ).rejects.toThrow("forced failure");

    expect(await counts(rut)).toEqual({ users: 0, admins: 0, audit: 0 });
  });

  it("does not create a user for a RUT that already exists without the explicit flag", async () => {
    const rut = randomRut();
    await client.query(
      'INSERT INTO "User" ("id","name","rut") VALUES (gen_random_uuid()::text,$1,$2)',
      ["Credentialless", rut],
    );

    await expect(
      createBootstrapService(prisma).bootstrap({
        name: "Ada",
        rut,
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(BootstrapRejectedError);

    expect(await counts(rut)).toEqual({ users: 1, admins: 0, audit: 0 });
  });

  it("designates an existing user only with a usable credential", async () => {
    const service = createBootstrapService(prisma);
    const unknown = randomRut();
    const credentialless = randomRut();
    const usable = randomRut();
    await client.query(
      'INSERT INTO "User" ("id","name","rut") VALUES (gen_random_uuid()::text,$1,$2)',
      ["Credentialless", credentialless],
    );
    await client.query(
      'INSERT INTO "User" ("id","name","rut","passwordHash") VALUES (gen_random_uuid()::text,$1,$2,$3)',
      ["Usable", usable, await hashPassword(PASSWORD)],
    );

    await expect(service.designateExisting(unknown)).rejects.toBeInstanceOf(
      BootstrapRejectedError,
    );
    await expect(
      service.designateExisting(credentialless),
    ).rejects.toBeInstanceOf(BootstrapRejectedError);
    expect((await counts(credentialless)).admins).toBe(0);

    let holder = true;
    const racing = createBootstrapService(prisma, {
      afterDesignated: async () => {
        if (!holder) return;
        holder = false;
        await waitForBlockedBackend();
      },
    });
    const outcomes = await Promise.all([
      racing.designateExisting(usable),
      racing.designateExisting(usable),
    ]);

    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "designated",
      "unchanged",
    ]);
    expect(await counts(usable)).toEqual({ users: 1, admins: 1, audit: 1 });
  });

  it("refuses to designate a user whose temporary password expired or has no expiry", async () => {
    const service = createBootstrapService(prisma);
    const hash = await hashPassword(PASSWORD);
    const make = async (
      mustChangePassword: boolean,
      temporaryPasswordExpiresAt: Date | null,
    ) => {
      const rut = randomRut();
      await prisma.user.create({
        data: {
          name: "Pending",
          rut,
          passwordHash: hash,
          mustChangePassword,
          temporaryPasswordExpiresAt,
        },
      });
      return rut;
    };
    const hour = 3_600_000;
    const expired = await make(true, new Date(Date.now() - hour));
    const noExpiry = await make(true, null);
    const live = await make(true, new Date(Date.now() + hour));
    const permanent = await make(false, null);

    for (const rut of [expired, noExpiry]) {
      await expect(service.designateExisting(rut)).rejects.toBeInstanceOf(
        BootstrapRejectedError,
      );
      expect((await counts(rut)).admins).toBe(0);
    }
    await expect(service.designateExisting(live)).resolves.toMatchObject({
      outcome: "designated",
    });
    await clearDesignation();
    await expect(service.designateExisting(permanent)).resolves.toMatchObject({
      outcome: "designated",
    });
  });
});

describe("RP0-03 bootstrapped administrator over HTTP", () => {
  it("logs in with the temporary password and sees no invoice contexts", async () => {
    const rut = randomRut();
    await createBootstrapService(prisma).bootstrap({
      name: "Ada Lovelace",
      rut: formatRut(rut),
      password: PASSWORD,
    });
    const app = createApp(database, createAuthService(prisma));

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: formatRut(rut), password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];

    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", cookie);
    expect(profile.status).toBe(200);
    expect(profile.body.profile).toMatchObject({
      mustChangePassword: true,
      isPlatformAdministrator: true,
      memberships: [],
    });
    expect(profile.body.profile.contexts ?? []).toEqual([]);

    const blocked = await request(app)
      .get("/api/v1/groups")
      .set("Cookie", cookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ONBOARDING_REQUIRED");
  });
});

describe("RP0-03 bootstrapped administrator and invoice authorization", () => {
  const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
  const NEW_PASSWORD = "a-new-permanent-password-1";

  it("sees no invoice data after the password change, with or without a real context", async () => {
    const rut = randomRut();
    await createBootstrapService(prisma).bootstrap({
      name: "Ada Lovelace",
      rut: formatRut(rut),
      password: PASSWORD,
    });
    // A real organization and group with an invoice the administrator is not
    // a member of: platform authority never reads tenant data.
    const author = await prisma.user.create({
      data: { name: "Author", rut: randomRut() },
    });
    const organization = await prisma.organization.create({
      data: { name: "Tenant", slug: `tenant-${randomUUID()}` },
    });
    await prisma.organizationMembership.create({
      data: {
        userId: author.id,
        organizationId: organization.id,
        role: "USER",
      },
    });
    const group = await prisma.group.create({
      data: {
        organizationId: organization.id,
        name: "Finance",
        readInvoices: true,
      },
    });
    await prisma.groupMembership.create({
      data: {
        groupId: group.id,
        userId: author.id,
        organizationId: organization.id,
      },
    });
    const businessId = `FAC-${randomUUID()}`;
    await prisma.invoice.create({
      data: {
        businessId,
        organizationId: organization.id,
        groupId: group.id,
        supplierName: "Proveedor local",
        amountPesos: 12500,
        currency: "CLP",
        issuedOn: new Date("2026-10-25"),
        dueOn: new Date("2026-11-25"),
        businessStatus: "PENDING",
        createdByUserId: author.id,
      },
    });
    const app = createApp(database, createAuthService(prisma), {
      invoices: createInvoiceService(prisma),
    });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: formatRut(rut), password: PASSWORD });
    const temporaryCookie = String(login.headers["set-cookie"]).split(";")[0];
    const query = (organizationId: string, groupId: string) =>
      `/api/v1/invoices?organizationId=${organizationId}&ownerType=group&ownerId=${groupId}`;

    const beforeChange = await request(app)
      .get(query(organization.id, group.id))
      .set("Cookie", temporaryCookie);
    expect(beforeChange.status).toBe(403);
    expect(beforeChange.body.error.code).toBe("ONBOARDING_REQUIRED");

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", temporaryCookie)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(204);
    const cookie = String(changed.headers["set-cookie"]).split(";")[0];

    const outsideContext = await request(app)
      .get(query(organization.id, group.id))
      .set("Cookie", cookie);
    const unknownContext = await request(app)
      .get(query(randomUUID(), randomUUID()))
      .set("Cookie", cookie);
    const ownScope = await request(app)
      .get(
        `/api/v1/invoices?organizationId=${organization.id}&ownerType=user&ownerId=${login.body.user.id}`,
      )
      .set("Cookie", cookie);
    const detail = await request(app)
      .get(
        `/api/v1/invoices/${randomUUID()}?organizationId=${organization.id}&ownerType=group&ownerId=${group.id}`,
      )
      .set("Cookie", cookie);

    for (const response of [outsideContext, unknownContext, ownScope, detail]) {
      expect([403, 404]).toContain(response.status);
      expect(response.body).not.toHaveProperty("invoices");
      expect(response.body).not.toHaveProperty("invoice");
      expect(JSON.stringify(response.body)).not.toContain(businessId);
    }
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", cookie);
    expect(profile.body.profile).toMatchObject({
      mustChangePassword: false,
      isPlatformAdministrator: true,
      memberships: [],
    });
    expect(profile.body.profile.contexts).toEqual([]);
  });
});
