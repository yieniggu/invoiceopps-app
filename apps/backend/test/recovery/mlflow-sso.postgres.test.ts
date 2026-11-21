import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { SAME_ORIGIN, membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";
import request from "../support/request.js";

const url = recoveryTestDatabaseUrl();
const SERVICE_SECRET = "m".repeat(48);
const CALLBACK = "https://mlflow.example.test/_gateway/callback";
const STATE = "t".repeat(24);

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth, {
  internalServiceSecret: SERVICE_SECRET,
  mlflowCallbackUrl: CALLBACK,
});
const {
  cookieFor,
  call,
  scenario: plainScenario,
} = membershipFixtures({
  prisma,
  client,
  auth,
  app,
  url,
});

// MLflow access is part of the Models section (mlEnabled): these suites run
// with the organization's section on; the "off" cases set it back explicitly.
const scenario = async () => {
  const s = await plainScenario();
  await prisma.organization.update({
    where: { id: s.org.id },
    data: { mlEnabled: true },
  });
  return s;
};

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const authorize = (cookie?: string, redirectUri = CALLBACK) => {
  const test = request(app)
    .get("/api/v1/mlflow/authorize")
    .query({ redirect_uri: redirectUri, state: STATE })
    .set("Host", "127.0.0.1");
  return cookie ? test.set("Cookie", cookie) : test;
};
const codeOf = (response: { headers: Record<string, unknown> }) =>
  new URL(response.headers.location as string).searchParams.get(
    "code",
  ) as string;
const exchange = (code: string, credential: string | null = SERVICE_SECRET) => {
  const test = request(app)
    .post("/internal/sessions/exchange")
    .set("Host", "127.0.0.1");
  if (credential !== null) test.set("Authorization", `Bearer ${credential}`);
  return test.send({ code });
};
const introspect = (sessionToken: string) =>
  request(app)
    .post("/internal/sessions/introspect")
    .set("Host", "127.0.0.1")
    .set("Authorization", `Bearer ${SERVICE_SECRET}`)
    .send({ sessionToken });

async function memberWithSession() {
  const s = await scenario();
  return { s, cookie: await cookieFor(s.member) };
}
async function childFor(cookie: string) {
  const code = codeOf(await authorize(cookie));
  const response = await exchange(code);
  expect(response.body.active).toBe(true);
  return response.body.sessionToken as string;
}

describe("MLflow SSO handoff against PostgreSQL", () => {
  it("issues a code bound to the session and exchanges it for a child session", async () => {
    const { s, cookie } = await memberWithSession();

    const redirect = await authorize(cookie);

    expect(redirect.status).toBe(302);
    const target = new URL(redirect.headers.location as string);
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK);
    expect(target.searchParams.get("state")).toBe(STATE);
    const code = codeOf(redirect);
    expect(Buffer.from(code, "base64url").length).toBeGreaterThanOrEqual(32);
    // Only the hash is stored.
    const stored = await prisma.mlflowHandoffCode.findMany({
      where: { userId: s.member.id },
    });
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(code);
    const ttl = stored[0]!.expiresAt.getTime() - stored[0]!.createdAt.getTime();
    expect(ttl).toBeLessThanOrEqual(60_000 + 1000);

    const exchanged = await exchange(code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.active).toBe(true);
    expect(exchanged.body.sessionToken).toMatch(/^mls_/);
    const resolved = await introspect(exchanged.body.sessionToken);
    expect(resolved.body.active).toBe(true);
    expect(resolved.body.userId).toBe(s.member.id);
    expect(resolved.body.contexts[0].organizationId).toBe(s.org.id);
  });

  it("sends a visitor without a valid session to sign in and stores nothing", async () => {
    const { s, cookie } = await memberWithSession();
    await call("post", "/auth/logout", cookie);

    for (const sent of [undefined, cookie, "invoiceops_session=bogus"]) {
      const response = await authorize(sent);
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    }
    expect(
      await prisma.mlflowHandoffCode.count({ where: { userId: s.member.id } }),
    ).toBe(0);
  });

  it("answers 400 without redirecting or storing for a wrong redirect_uri", async () => {
    const { s, cookie } = await memberWithSession();

    const response = await authorize(
      cookie,
      "https://evil.example/_gateway/callback",
    );

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(
      await prisma.mlflowHandoffCode.count({ where: { userId: s.member.id } }),
    ).toBe(0);
  });

  it("refuses a user without any MLflow context (no redirect loop)", async () => {
    const { s, cookie } = await memberWithSession();
    await prisma.organizationMembership.deleteMany({
      where: { userId: s.member.id },
    });

    const response = await authorize(cookie);

    expect(response.status).toBe(403);
    expect(response.headers.location).toBeUndefined();
  });

  it("makes a code single use, including under concurrent exchanges", async () => {
    const { cookie } = await memberWithSession();
    const code = codeOf(await authorize(cookie));

    const results = await Promise.all([
      exchange(code),
      exchange(code),
      exchange(code),
      exchange(code),
    ]);

    expect(results.filter((r) => r.body.active === true)).toHaveLength(1);
    expect((await exchange(code)).body).toEqual({ active: false });
  });

  it("rejects an expired code, an unknown code and a missing service secret", async () => {
    const { s, cookie } = await memberWithSession();
    const code = codeOf(await authorize(cookie));
    await prisma.mlflowHandoffCode.updateMany({
      where: { userId: s.member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const fresh = codeOf(await authorize(cookie));

    expect((await exchange(code)).body).toEqual({ active: false });
    expect((await exchange("never-issued")).body).toEqual({ active: false });
    expect((await exchange(fresh, null)).status).toBe(401);
    expect((await exchange(fresh, "w".repeat(48))).status).toBe(401);
    // The refused attempts did not consume the fresh code.
    expect((await exchange(fresh)).body.active).toBe(true);
  });

  it("dies with the app session: logout revokes the child and kills pending codes", async () => {
    const { cookie } = await memberWithSession();
    const child = await childFor(cookie);
    const pending = codeOf(await authorize(cookie));
    expect((await introspect(child)).body.active).toBe(true);

    expect((await call("post", "/auth/logout", cookie)).status).toBe(204);

    expect((await introspect(child)).body).toEqual({
      active: false,
      cacheTtlSeconds: 5,
    });
    expect((await exchange(pending)).body).toEqual({ active: false });
  });

  it("is revoked when the password changes (the parent sessions are rotated)", async () => {
    const { cookie } = await memberWithSession();
    const child = await childFor(cookie);

    const changed = await call("post", "/auth/change-password", cookie, {
      currentPassword: "correct-horse-battery",
      newPassword: "another-long-passphrase-9",
    });
    expect(changed.status).toBe(204);

    expect((await introspect(child)).body.active).toBe(false);
  });

  it("cannot authenticate app routes, and an app session is not a child", async () => {
    const { cookie } = await memberWithSession();
    const child = await childFor(cookie);

    for (const route of ["/auth/profile", "/api-tokens?organizationId=x"]) {
      const response = await call("get", route, `invoiceops_session=${child}`);
      expect(response.status).toBe(401);
    }
    const asBearer = await request(app)
      .get("/api/v1/invoices")
      .set(SAME_ORIGIN)
      .set("Authorization", `Bearer ${child}`);
    expect(asBearer.status).toBe(401);
    const parentToken = cookie.replace(/^[^=]+=/, "");
    expect((await introspect(parentToken)).body.active).toBe(false);
  });

  it("caps the child lifetime by the parent's expiry and its own maximum", async () => {
    const { s, cookie } = await memberWithSession();
    const soon = new Date(Date.now() + 10 * 60_000);
    await prisma.session.updateMany({
      where: { userId: s.member.id },
      data: { expiresAt: soon },
    });
    const short = await childFor(cookie);
    const shortRow = await prisma.mlflowSession.findFirstOrThrow({
      where: { userId: s.member.id },
    });
    expect(shortRow.expiresAt.getTime()).toBeLessThanOrEqual(soon.getTime());
    expect((await introspect(short)).body.active).toBe(true);

    const other = await memberWithSession();
    await childFor(other.cookie);
    const longRow = await prisma.mlflowSession.findFirstOrThrow({
      where: { userId: other.s.member.id },
    });
    expect(longRow.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      8 * 60 * 60 * 1000,
    );

    // An expired child, or an expired parent, is inactive.
    await prisma.mlflowSession.update({
      where: { id: shortRow.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await introspect(short)).body.active).toBe(false);
  });

  it("revokes only the presented child through the private route", async () => {
    const { cookie } = await memberWithSession();
    const first = await childFor(cookie);
    const second = await childFor(cookie);

    const revoke = (
      token: string,
      credential: string | null = SERVICE_SECRET,
    ) => {
      const test = request(app)
        .post("/internal/sessions/revoke")
        .set("Host", "127.0.0.1");
      if (credential) test.set("Authorization", `Bearer ${credential}`);
      return test.send({ sessionToken: token });
    };
    expect((await revoke(first, null)).status).toBe(401);
    expect((await introspect(first)).body.active).toBe(true);
    expect((await revoke(first)).status).toBe(204);
    expect((await revoke(first)).status).toBe(204); // idempotent
    expect((await introspect(first)).body.active).toBe(false);
    expect((await introspect(second)).body.active).toBe(true);
    // The app session is untouched.
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);
  });
});
