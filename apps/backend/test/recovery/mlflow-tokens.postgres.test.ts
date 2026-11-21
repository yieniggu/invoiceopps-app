import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { createApiTokenIntrospectionService } from "../../src/features/api-tokens/introspection.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  DAY_MS,
  bearerCall,
  seedApiToken,
  type ApiScope,
} from "./api-token-fixtures.js";
import { SAME_ORIGIN, membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";
import request from "../support/request.js";

const url = recoveryTestDatabaseUrl();
const SERVICE_SECRET = "m".repeat(48);

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const CALLBACK = "https://mlflow.example.test/_gateway/callback";
const app = createApp(database, auth, {
  internalServiceSecret: SERVICE_SECRET,
  mlflowCallbackUrl: CALLBACK,
});
const {
  addToGroup,
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

const emit = (cookie: string | undefined, body: unknown) =>
  call("post", "/api-tokens", cookie, body);

const introspect = (
  token: string,
  credential: string | null = SERVICE_SECRET,
) => {
  const test = request(app)
    .post("/internal/api-tokens/introspect")
    .set("Host", "127.0.0.1");
  if (credential !== null) test.set("Authorization", `Bearer ${credential}`);
  return test.send({ token });
};

const body = (
  organizationId: string,
  scopes: ApiScope[],
  extra: Record<string, unknown> = {},
) => ({
  name: "notebook",
  organizationId,
  scopes,
  expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
  ...extra,
});

/** A member with NO invoice flags: MLflow scopes must not depend on them. */
async function memberScenario() {
  const s = await scenario();
  return { s, cookie: await cookieFor(s.member) };
}

describe("MLOPS-01 emission of mlflow scopes", () => {
  it("lets an active org member mint mlflow:read and mlflow:write without invoice flags", async () => {
    const { s, cookie } = await memberScenario();

    const response = await emit(
      cookie,
      body(s.org.id, ["mlflow:read", "mlflow:write"]),
    );

    expect(response.status).toBe(201);
    expect(response.body.token.scopes).toEqual(["mlflow:read", "mlflow:write"]);
    expect(response.body.secret).toMatch(/^iop_/);
    const stored = await prisma.apiToken.findUniqueOrThrow({
      where: { id: response.body.token.id },
    });
    expect(stored.scopes).toEqual(["MLFLOW_READ", "MLFLOW_WRITE"]);
  });

  it("lets a group member mint a group-scoped mlflow token", async () => {
    const { s, cookie } = await memberScenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);

    const response = await emit(
      cookie,
      body(s.org.id, ["mlflow:read"], { groupId: s.group.id }),
    );

    expect(response.status).toBe(201);
    expect(response.body.token.groupId).toBe(s.group.id);
  });

  it("answers 403 for a group token when the user is not in that group", async () => {
    const { s, cookie } = await memberScenario();

    const response = await emit(
      cookie,
      body(s.org.id, ["mlflow:read"], { groupId: s.group.id }),
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 to a non-member of the organization", async () => {
    const s = await scenario();

    const response = await emit(
      await cookieFor(s.outsider),
      body(s.org.id, ["mlflow:write"]),
    );

    expect(response.status).toBe(404);
  });

  it("answers 403 when the organization is disabled", async () => {
    const { s, cookie } = await memberScenario();
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { enabled: false },
    });

    const response = await emit(cookie, body(s.org.id, ["mlflow:read"]));

    expect(response.status).toBe(403);
  });

  it("still enforces invoice flags on a mixed request", async () => {
    const { s, cookie } = await memberScenario();

    const response = await emit(
      cookie,
      body(s.org.id, ["mlflow:read", "invoices:read"]),
    );

    expect(response.status).toBe(403);
    expect(
      await prisma.apiToken.count({ where: { userId: s.member.id } }),
    ).toBe(0);
  });
});

describe("MLOPS-01 POST /internal/api-tokens/introspect", () => {
  async function mint(scopes: ApiScope[] = ["mlflow:read", "mlflow:write"]) {
    const { s, cookie } = await memberScenario();
    const created = await emit(cookie, body(s.org.id, scopes));
    expect(created.status).toBe(201);
    return {
      s,
      cookie,
      tokenId: created.body.token.id as string,
      secret: created.body.secret as string,
    };
  }

  it("returns the identity and scopes of a valid token", async () => {
    const { s, secret } = await mint();

    const response = await introspect(secret);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      active: true,
      userId: s.member.id,
      organizationId: s.org.id,
      groupId: null,
      scopes: ["mlflow:read", "mlflow:write"],
      cacheTtlSeconds: 30,
    });
    expect(response.headers["cache-control"]).toBe("private, max-age=30");
  });

  it("returns the group of a group token and updates lastUsedAt without blocking", async () => {
    const { s, cookie } = await memberScenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const created = await emit(
      cookie,
      body(s.org.id, ["mlflow:read"], { groupId: s.group.id }),
    );

    const response = await introspect(created.body.secret);

    expect(response.body).toMatchObject({ active: true, groupId: s.group.id });
    await expect
      .poll(
        async () =>
          (
            await prisma.apiToken.findUniqueOrThrow({
              where: { id: created.body.token.id },
            })
          ).lastUsedAt,
      )
      .not.toBeNull();
  });

  it("throttles lastUsedAt writes", async () => {
    const { tokenId, secret } = await mint();
    // The write is fire-and-forget; a thin wrapper keeps its promise so the
    // test waits for the write itself (no sleeping) before it looks.
    const writes: Promise<unknown>[] = [];
    const tracked = {
      apiToken: {
        findUnique: (args: never) => prisma.apiToken.findUnique(args),
        updateMany: (args: never) => {
          const write = prisma.apiToken.updateMany(args);
          writes.push(write.catch(() => undefined));
          return write;
        },
      },
      organizationMembership: prisma.organizationMembership,
    } as unknown as PrismaClient;
    const service = createApiTokenIntrospectionService(tracked);
    const lastUsed = async () =>
      (await prisma.apiToken.findUniqueOrThrow({ where: { id: tokenId } }))
        .lastUsedAt;

    expect((await service.introspect(secret)).active).toBe(true);
    await Promise.all(writes);
    const first = await lastUsed();
    expect(first).not.toBeNull();

    expect((await service.introspect(secret)).active).toBe(true);
    await Promise.all(writes);

    expect(writes).toHaveLength(2);
    expect((await lastUsed())?.getTime()).toBe(first?.getTime());
  });

  it("reports a revoked token inactive immediately", async () => {
    const { cookie, tokenId, secret } = await mint();
    expect((await introspect(secret)).body.active).toBe(true);

    const revoked = await call("delete", `/api-tokens/${tokenId}`, cookie);
    const response = await introspect(secret);

    expect(revoked.status).toBe(204);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: false, cacheTtlSeconds: 5 });
  });

  it("reports an expired token inactive", async () => {
    const { s } = await memberScenario();
    const { secret } = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
      scopes: ["mlflow:read"],
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await introspect(secret)).body).toEqual({
      active: false,
      cacheTtlSeconds: 5,
    });
  });

  it("reports unknown and malformed tokens inactive, with no reason", async () => {
    for (const token of [`iop_${"z".repeat(43)}`, "garbage"]) {
      const response = await introspect(token);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ active: false, cacheTtlSeconds: 5 });
    }
  });

  it("reports a token without mlflow scopes inactive but keeps it working for invoices", async () => {
    const s = await scenario();
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: true },
    });
    const { secret } = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
      scopes: ["invoices:read"],
    });

    expect((await introspect(secret)).body.active).toBe(false);
    const invoices = await bearerCall(
      app,
      "get",
      `/invoices?organizationId=${s.org.id}`,
      secret,
    );
    expect(invoices.status).not.toBe(401);
  });

  it("reports inactive once the organization membership is removed", async () => {
    const { s, secret } = await mint();
    await prisma.organizationMembership.delete({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
    });

    expect((await introspect(secret)).body.active).toBe(false);
  });

  it("reports a group token inactive once the group membership is removed", async () => {
    const { s, cookie } = await memberScenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const created = await emit(
      cookie,
      body(s.org.id, ["mlflow:write"], { groupId: s.group.id }),
    );
    expect((await introspect(created.body.secret)).body.active).toBe(true);

    await prisma.groupMembership.deleteMany({
      where: { groupId: s.group.id, userId: s.member.id },
    });

    expect((await introspect(created.body.secret)).body.active).toBe(false);
  });

  it("reports inactive for a deactivated user, a pending onboarding and a disabled organization", async () => {
    const mutations: Array<
      (s: Awaited<ReturnType<typeof scenario>>) => Promise<unknown>
    > = [
      (s) =>
        prisma.user.update({
          where: { id: s.member.id },
          data: { disabledAt: new Date() },
        }),
      (s) =>
        prisma.user.update({
          where: { id: s.member.id },
          data: { mustChangePassword: true },
        }),
      (s) =>
        prisma.organization.update({
          where: { id: s.org.id },
          data: { enabled: false },
        }),
    ];
    for (const mutate of mutations) {
      const { s, secret } = await mint();
      expect((await introspect(secret)).body.active).toBe(true);
      await mutate(s);
      expect((await introspect(secret)).body.active).toBe(false);
    }
  });

  it("refuses a wrong or missing service credential", async () => {
    const { secret } = await mint();

    expect((await introspect(secret, "w".repeat(48))).status).toBe(401);
    expect((await introspect(secret, null)).status).toBe(401);
  });

  it("is not reachable with a user session or a user token", async () => {
    const { cookie, secret } = await mint();

    const session = await request(app)
      .post("/internal/api-tokens/introspect")
      .set({ Host: "127.0.0.1", Origin: "http://127.0.0.1" })
      .set("Cookie", cookie)
      .send({ token: secret });
    const asUserToken = await introspect(secret, secret);

    expect(session.status).toBe(401);
    expect(asUserToken.status).toBe(401);
  });
});

describe("MLOPS-02 POST /internal/sessions/introspect", () => {
  const introspectSession = (
    sessionToken: string,
    credential: string | null = SERVICE_SECRET,
  ) => {
    const test = request(app)
      .post("/internal/sessions/introspect")
      .set("Host", "127.0.0.1");
    if (credential !== null) test.set("Authorization", `Bearer ${credential}`);
    return test.send({ sessionToken });
  };
  /** The gateway's credential: a child session obtained through the handoff. */
  const childOf = async (cookie: string) => {
    const authorize = await request(app)
      .get("/api/v1/mlflow/authorize")
      .query({ redirect_uri: CALLBACK, state: "s".repeat(24) })
      .set("Host", "127.0.0.1")
      .set("Cookie", cookie);
    const code = new URL(authorize.headers.location as string).searchParams.get(
      "code",
    ) as string;
    const exchanged = await request(app)
      .post("/internal/sessions/exchange")
      .set("Host", "127.0.0.1")
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ code });
    return exchanged.body.sessionToken as string;
  };

  it("returns the organization context and every group the user belongs to", async () => {
    const { s, cookie } = await memberScenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);

    const response = await introspectSession(await childOf(cookie));

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(true);
    expect(response.body.userId).toBe(s.member.id);
    expect(response.body.cacheTtlSeconds).toBe(30);
    expect(response.body.contexts).toEqual([
      { organizationId: s.org.id, groupId: null, label: s.org.name },
      {
        organizationId: s.org.id,
        groupId: s.group.id,
        label: `${s.org.name} / Finance`,
      },
    ]);
  });

  it("does not list groups the user is not a member of or other organizations", async () => {
    const { s, cookie } = await memberScenario();
    const other = await prisma.organization.create({
      data: { name: "Other", slug: `other-${s.org.id}` },
    });
    await prisma.group.create({
      data: { organizationId: other.id, name: "Elsewhere" },
    });

    const response = await introspectSession(await childOf(cookie));

    expect(response.body.contexts).toEqual([
      { organizationId: s.org.id, groupId: null, label: s.org.name },
    ]);
  });

  it("reports inactive without a reason for unknown, logged-out and expired sessions", async () => {
    const { cookie } = await memberScenario();
    const expired = await memberScenario();
    const expiredChild = await childOf(expired.cookie);
    await prisma.session.updateMany({
      where: { userId: expired.s.member.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const gone = await memberScenario();
    const goneChild = await childOf(gone.cookie);
    await call("post", "/auth/logout", gone.cookie);
    // The app session itself is never accepted here, only the child.
    const parent = await memberScenario();

    for (const value of [
      "unknown-session",
      expiredChild,
      goneChild,
      parent.cookie.replace(/^[^=]+=/, ""),
    ]) {
      expect((await introspectSession(value)).body).toEqual({
        active: false,
        cacheTtlSeconds: 5,
      });
    }
    expect((await introspectSession(await childOf(cookie))).body.active).toBe(
      true,
    );
  });

  it("reports inactive for a deactivated user, a pending onboarding, a disabled organization and a removed membership", async () => {
    const mutations: Array<
      (s: Awaited<ReturnType<typeof scenario>>) => Promise<unknown>
    > = [
      (s) =>
        prisma.user.update({
          where: { id: s.member.id },
          data: { disabledAt: new Date() },
        }),
      (s) =>
        prisma.user.update({
          where: { id: s.member.id },
          data: { mustChangePassword: true },
        }),
      (s) =>
        prisma.organization.update({
          where: { id: s.org.id },
          data: { enabled: false },
        }),
      (s) =>
        prisma.organizationMembership.delete({
          where: {
            userId_organizationId: {
              userId: s.member.id,
              organizationId: s.org.id,
            },
          },
        }),
    ];
    for (const mutate of mutations) {
      const { s, cookie } = await memberScenario();
      const child = await childOf(cookie);
      expect((await introspectSession(child)).body.active).toBe(true);
      await mutate(s);
      expect((await introspectSession(child)).body.active).toBe(false);
    }
  });

  it("answers 401 without the service credential and to a user session cookie", async () => {
    const { cookie } = await memberScenario();
    const child = await childOf(cookie);

    expect((await introspectSession(child, null)).status).toBe(401);
    expect((await introspectSession(child, "w".repeat(48))).status).toBe(401);
    const asUser = await request(app)
      .post("/internal/sessions/introspect")
      .set(SAME_ORIGIN)
      .set("Cookie", cookie)
      .send({ sessionToken: child });
    expect(asUser.status).toBe(401);
  });
});
