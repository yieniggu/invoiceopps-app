import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import request from "../support/request.js";
import { DAY_MS } from "./api-token-fixtures.js";
import { membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

// CR-509: the organization's mlEnabled switch also gates every MLflow access,
// and every change of it leaves a durable audit event.
const url = recoveryTestDatabaseUrl();
const SERVICE_SECRET = "c3f1a8e07d5b94260fae18c3d7b5e902";
const CALLBACK = "https://mlflow.example.test/_gateway/callback";
const STATE = "a".repeat(22);
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth, {
  internalServiceSecret: SERVICE_SECRET,
  mlflowCallbackUrl: CALLBACK,
});
const f = membershipFixtures({ prisma, client, auth, app, url });

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const internal = (path: string, body: object) =>
  request(app)
    .post(path)
    .set("Host", "127.0.0.1")
    .set("Authorization", `Bearer ${SERVICE_SECRET}`)
    .send(body);

async function world(mlEnabled: boolean) {
  const s = await f.scenario();
  await prisma.organization.update({
    where: { id: s.org.id },
    data: { mlEnabled },
  });
  return {
    ...s,
    adminCookie: await f.cookieFor(s.admin),
    memberCookie: await f.cookieFor(s.member),
  };
}
type World = Awaited<ReturnType<typeof world>>;

const issue = (s: World, scopes: string[], groupId?: string) =>
  f.call("post", "/api-tokens", s.memberCookie, {
    name: "notebook",
    organizationId: s.org.id,
    ...(groupId ? { groupId } : {}),
    scopes,
    expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
  });
const setMl = (s: World, mlEnabled: boolean) =>
  f.call("patch", `/organizations/${s.org.id}`, s.adminCookie, { mlEnabled });
const authorize = (cookie: string) =>
  request(app)
    .get("/api/v1/mlflow/authorize")
    .query({ redirect_uri: CALLBACK, state: STATE })
    .set("Host", "127.0.0.1")
    .set("Cookie", cookie);
const childSession = async (cookie: string) => {
  const redirect = await authorize(cookie);
  expect(redirect.status).toBe(302);
  const code = new URL(redirect.headers.location as string).searchParams.get(
    "code",
  );
  const exchanged = await internal("/internal/sessions/exchange", { code });
  expect(exchanged.body.active).toBe(true);
  return exchanged.body.sessionToken as string;
};
const auditOf = (organizationId: string) =>
  prisma.platformAdministrativeAuditEvent.findMany({
    where: { organizationId, type: "ORGANIZATION_UPDATED" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

describe("mlEnabled gates every MLflow access (CR-509)", () => {
  it("refuses mlflow:* token issuance while the Models section is off, and allows it when on", async () => {
    const off = await world(false);
    const refused = await issue(off, ["mlflow:read"]);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    // Invoice-only tokens are unaffected by the switch.
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: off.member.id,
          organizationId: off.org.id,
        },
      },
      data: { readInvoices: true },
    });
    expect((await issue(off, ["invoices:read"])).status).toBe(201);

    const on = await world(true);
    expect((await issue(on, ["mlflow:read", "mlflow:write"])).status).toBe(201);
  });

  it("turns an already issued mlflow token and child session inactive when the switch goes off, and active again when it returns", async () => {
    const s = await world(true);
    const token = await issue(s, ["mlflow:read"]);
    expect(token.status).toBe(201);
    const secret = token.body.secret as string;
    const child = await childSession(s.memberCookie);
    const tokenActive = async () =>
      (await internal("/internal/api-tokens/introspect", { token: secret }))
        .body;
    const sessionActive = async () =>
      (await internal("/internal/sessions/introspect", { sessionToken: child }))
        .body;

    expect((await tokenActive()).active).toBe(true);
    expect((await sessionActive()).active).toBe(true);

    expect((await setMl(s, false)).status).toBe(200);
    expect(await tokenActive()).toEqual({ active: false, cacheTtlSeconds: 5 });
    expect(await sessionActive()).toEqual({
      active: false,
      cacheTtlSeconds: 5,
    });
    // A new handoff has no context to offer.
    expect((await authorize(s.memberCookie)).status).toBe(403);

    expect((await setMl(s, true)).status).toBe(200);
    expect((await tokenActive()).active).toBe(true);
    expect((await sessionActive()).active).toBe(true);
    expect((await authorize(s.memberCookie)).status).toBe(302);
  });

  it("only drops the contexts of the organization that switched off", async () => {
    const s = await world(true);
    const other = await f.makeOrg("second");
    await prisma.organization.update({
      where: { id: other.id },
      data: { mlEnabled: true },
    });
    await f.join(s.member.id, other.id, "USER");
    const child = await childSession(s.memberCookie);
    const contexts = async () =>
      (await internal("/internal/sessions/introspect", { sessionToken: child }))
        .body.contexts as Array<{ organizationId: string }>;
    expect(new Set((await contexts()).map((c) => c.organizationId))).toEqual(
      new Set([s.org.id, other.id]),
    );

    await setMl(s, false);

    expect((await contexts()).map((c) => c.organizationId)).toEqual([other.id]);
  });
});

describe("mlEnabled changes are audited durably (CR-509)", () => {
  it("records the old and new value, only for a real change of the switch", async () => {
    const s = await world(false);

    expect((await setMl(s, true)).status).toBe(200);
    expect((await setMl(s, true)).status).toBe(200);
    expect((await setMl(s, false)).status).toBe(200);
    const rename = await f.call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { name: `Renamed ${randomUUID()}` },
    );
    expect(rename.status).toBe(200);

    const events = await auditOf(s.org.id);
    // The repeat of the same value wrote nothing; the rename carries no ML values.
    expect(
      events.map((event) => [event.mlEnabledFrom, event.mlEnabledTo]),
    ).toEqual([
      [false, true],
      [true, false],
      [null, null],
    ]);
    for (const event of events) {
      expect(event.actorUserId).toBe(s.admin.id);
      expect(event.organizationId).toBe(s.org.id);
    }
  });

  it("keeps the new columns immutable like the rest of the audit table", async () => {
    const s = await world(false);
    await setMl(s, true);
    const [event] = await auditOf(s.org.id);
    await expect(
      client.query(
        'UPDATE "PlatformAdministrativeAuditEvent" SET "mlEnabledTo" = false WHERE "id" = $1',
        [event!.id],
      ),
    ).rejects.toThrow();
    expect((await auditOf(s.org.id))[0]!.mlEnabledTo).toBe(true);
  });
});
