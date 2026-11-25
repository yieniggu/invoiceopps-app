import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { defaultModelsConfig } from "../../src/features/models/config.js";
import { createModelApiClient } from "../../src/features/models/model-api-client.js";
import { createModelRegistryClient } from "../../src/features/models/registry-client.js";
import { createModelsService } from "../../src/features/models/services.js";
import {
  GATEWAY_TOKEN,
  MODEL_API_TOKEN,
  startFakeGateway,
  startFakeModelApi,
  type FakeGateway,
  type FakeModelApi,
} from "../support/fake-model-services.js";
import { bearerCall, seedApiToken } from "./api-token-fixtures.js";
import { waitFor } from "../support/wait-for.js";
import { membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);

let modelApi: FakeModelApi;
let gateway: FakeGateway;

function buildApp(
  overrides: Partial<ReturnType<typeof defaultModelsConfig>> = {},
  configured = true,
) {
  const config = {
    ...defaultModelsConfig(),
    mlflowPublicUrl: "https://mlflow.example.test",
    ...overrides,
  };
  return createApp(database, auth, {
    models: createModelsService(prisma, {
      config,
      ...(configured
        ? {
            modelApi: createModelApiClient({
              url: modelApi.url,
              token: MODEL_API_TOKEN,
            }),
            registry: createModelRegistryClient({
              url: gateway.url,
              token: GATEWAY_TOKEN,
            }),
          }
        : {}),
    }),
  });
}

let app = createApp(database, auth);
const fixtures = () => membershipFixtures({ prisma, client, auth, app, url });
let f = fixtures();

beforeAll(async () => {
  await client.connect();
  modelApi = await startFakeModelApi();
  gateway = await startFakeGateway();
});
afterAll(async () => {
  await modelApi.close();
  await gateway.close();
  await client.end();
  await prisma.$disconnect();
});
beforeEach(() => {
  modelApi.calls.length = 0;
  modelApi.loaded.clear();
  modelApi.quarantined.clear();
  modelApi.putMode = "pass";
  modelApi.putGate = null;
  modelApi.down = false;
  gateway.calls.length = 0;
  gateway.versions.clear();
  gateway.down = false;
  use(buildApp());
});

/** One pass of the periodic maintenance task (CR-508), driven explicitly. */
function reconcileNow() {
  return createModelsService(prisma, {
    config: defaultModelsConfig(),
    modelApi: createModelApiClient({
      url: modelApi.url,
      token: MODEL_API_TOKEN,
    }),
  }).reconcile();
}

/**
 * The recovery database is shared by every test of the run, and a reconcile
 * pass is global (eager reloads of ACTIVE deployments with scoring on, capped
 * per pass). Rows left by other tests would fill the cap or add loaded ids, so
 * a test that asserts on a whole pass first turns scoring off elsewhere and
 * keeps only its own organization's deployments in play.
 */
async function isolateReconcile(organizationId: string) {
  await prisma.deployment.updateMany({
    where: { organizationId: { not: organizationId }, inferenceEnabled: true },
    data: { inferenceEnabled: false },
  });
}

function use(next: ReturnType<typeof createApp>) {
  app = next;
  f = fixtures();
}

/** Org with ml on, an org ADMIN, a deployer, a plain member and an outsider. */
async function team(options: { mlEnabled?: boolean } = {}) {
  const s = await f.scenario();
  await prisma.organization.update({
    where: { id: s.org.id },
    data: { mlEnabled: options.mlEnabled ?? true },
  });
  const deployer = await f.makeUser("Dana Deployer");
  await f.join(deployer.id, s.org.id, "USER", { deployModels: true });
  return {
    ...s,
    deployer,
    adminCookie: await f.cookieFor(s.admin),
    deployerCookie: await f.cookieFor(deployer),
    memberCookie: await f.cookieFor(s.member),
    outsiderCookie: await f.cookieFor(s.outsider),
  };
}

const deployBody = (
  organizationId: string,
  extra: Record<string, unknown> = {},
) => ({
  organizationId,
  registeredModel: "invoice-risk",
  version: "3",
  ...extra,
});

const ctx = (organizationId: string, groupId?: string) =>
  `organizationId=${organizationId}${groupId ? `&groupId=${groupId}` : ""}`;

describe("MLOPS-05 org flag and authorization", () => {
  it("defaults mlEnabled to off and hides every endpoint (404) while it is off", async () => {
    const s = await team({ mlEnabled: false });
    const fresh = await f.makeOrg("fresh");
    expect(fresh.mlEnabled).toBe(false);

    for (const cookie of [s.deployerCookie, s.adminCookie]) {
      expect(
        (await f.call("get", `/models?${ctx(s.org.id)}`, cookie)).status,
      ).toBe(404);
      expect(
        (await f.call("get", `/deployments?${ctx(s.org.id)}`, cookie)).status,
      ).toBe(404);
      expect(
        (await f.call("post", "/deployments", cookie, deployBody(s.org.id)))
          .status,
      ).toBe(404);
    }
    expect(modelApi.calls).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });

  it("lets an org ADMIN switch the flag on and shows it in the profile", async () => {
    const s = await team({ mlEnabled: false });
    const off = await f.call("get", "/auth/profile", s.adminCookie);
    expect(off.body.profile.memberships[0].organization.mlEnabled).toBe(false);

    const toggle = await f.call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      {
        mlEnabled: true,
      },
    );
    expect(toggle.status).toBe(200);
    expect(toggle.body.organization.mlEnabled).toBe(true);
    // A plain member cannot.
    const denied = await f.call(
      "patch",
      `/organizations/${s.org.id}`,
      s.memberCookie,
      {
        mlEnabled: false,
      },
    );
    expect(denied.status).toBe(403);

    const on = await f.call("get", "/auth/profile", s.adminCookie);
    expect(on.body.profile.memberships[0].organization.mlEnabled).toBe(true);
    expect(
      (await f.call("get", `/deployments?${ctx(s.org.id)}`, s.memberCookie))
        .status,
    ).toBe(200);
  });

  it("answers 403 without deployModels (list stays readable) and no role grants it", async () => {
    const s = await team();
    for (const cookie of [s.memberCookie, s.adminCookie]) {
      const post = await f.call(
        "post",
        "/deployments",
        cookie,
        deployBody(s.org.id),
      );
      expect(post.status).toBe(403);
      expect(post.body.error.code).toBe("FORBIDDEN");
      expect(
        (
          await f.call(
            "patch",
            `/deployments/${crypto.randomUUID()}?${ctx(s.org.id)}`,
            cookie,
            { inferenceEnabled: true },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.call(
            "delete",
            `/deployments/${crypto.randomUUID()}?${ctx(s.org.id)}`,
            cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (await f.call("get", `/deployments?${ctx(s.org.id)}`, cookie)).status,
      ).toBe(200);
    }
    // Only the (read-only) list reconcile reaches the Model API.
    expect(modelApi.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("manages deployModels like the other permissions, audit included", async () => {
    const s = await team();
    const response = await f.call(
      "put",
      `/organizations/${s.org.id}/memberships/${s.member.id}/permissions`,
      s.adminCookie,
      {
        permissions: {
          readInvoices: false,
          createInvoices: false,
          deleteOwnInvoices: false,
          deleteOthersInvoices: false,
          deployModels: true,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.body.membership.permissions.deployModels).toBe(true);
    const audit =
      await prisma.platformAdministrativeAuditEvent.findFirstOrThrow({
        where: {
          type: "MEMBERSHIP_PERMISSIONS_CHANGED",
          targetUserId: s.member.id,
        },
      });
    expect(audit.deployModels).toBe(true);
    // The member can now deploy.
    const post = await f.call(
      "post",
      "/deployments",
      s.memberCookie,
      deployBody(s.org.id),
    );
    expect(post.status).toBe(201);
    // A legacy body without the flag leaves it unchanged (CR-510): the member
    // keeps the permission they were granted above.
    const legacy = await f.call(
      "put",
      `/organizations/${s.org.id}/memberships/${s.member.id}/permissions`,
      s.adminCookie,
      {
        permissions: {
          readInvoices: true,
          createInvoices: false,
          deleteOwnInvoices: false,
          deleteOthersInvoices: false,
        },
      },
    );
    expect(legacy.body.membership.permissions.deployModels).toBe(true);
    expect(legacy.body.membership.permissions.readInvoices).toBe(true);
  });

  it("answers 404 to a user of another organization and to a non-member", async () => {
    const s = await team();
    const other = await team();
    for (const cookie of [s.outsiderCookie, other.deployerCookie]) {
      expect(
        (await f.call("get", `/models?${ctx(s.org.id)}`, cookie)).status,
      ).toBe(404);
      expect(
        (await f.call("get", `/deployments?${ctx(s.org.id)}`, cookie)).status,
      ).toBe(404);
      expect(
        (await f.call("post", "/deployments", cookie, deployBody(s.org.id)))
          .status,
      ).toBe(404);
    }
    expect(modelApi.calls).toEqual([]);
  });

  it("answers 404 for a group of another organization and 403 for a non-member of the group", async () => {
    const s = await team();
    const other = await team();
    const foreignGroup = await f.makeGroup(other.org.id);
    expect(
      (
        await f.call(
          "get",
          `/deployments?${ctx(s.org.id, foreignGroup.id)}`,
          s.deployerCookie,
        )
      ).status,
    ).toBe(404);
    // The deployer belongs to the organization but not to the group.
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id, { groupId: s.group.id }),
        )
      ).status,
    ).toBe(403);
  });

  it("answers 404 for a deployment id of another context, never revealing it", async () => {
    const s = await team();
    await f.addToGroup(s.group.id, s.deployer.id, s.org.id);
    const other = await team();
    const created = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    const id = created.body.deployment.id as string;

    // Same organization, but asked through the group context.
    for (const method of ["patch", "delete"] as const) {
      const response = await f.call(
        method,
        `/deployments/${id}?${ctx(s.org.id, s.group.id)}`,
        s.deployerCookie,
        method === "patch" ? { inferenceEnabled: true } : undefined,
      );
      expect(response.status).toBe(404);
      // Another organization's deployer.
      const foreign = await f.call(
        method,
        `/deployments/${id}?${ctx(other.org.id)}`,
        other.deployerCookie,
        method === "patch" ? { inferenceEnabled: true } : undefined,
      );
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(response.body);
    }
    // A malformed id is the same 404.
    expect(
      (
        await f.call(
          "delete",
          `/deployments/not-a-uuid?${ctx(s.org.id)}`,
          s.deployerCookie,
        )
      ).status,
    ).toBe(404);
    const row = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("rejects an API token on every operation (session only)", async () => {
    const s = await team();
    const token = await seedApiToken(prisma, {
      userId: s.deployer.id,
      organizationId: s.org.id,
      scopes: ["mlflow:read", "mlflow:write", "invoices:read"],
    });
    const id = crypto.randomUUID();
    const calls: Array<[string, string, unknown?]> = [
      ["get", `/models?${ctx(s.org.id)}`],
      ["get", `/deployments?${ctx(s.org.id)}`],
      ["post", "/deployments", deployBody(s.org.id)],
      [
        "patch",
        `/deployments/${id}?${ctx(s.org.id)}`,
        { inferenceEnabled: true },
      ],
      ["delete", `/deployments/${id}?${ctx(s.org.id)}`],
    ];
    for (const [method, path, body] of calls) {
      const response = await bearerCall(
        app,
        method as "get",
        path,
        token.secret,
        body,
      );
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(modelApi.calls).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });
});

describe("MLOPS-05 registered models", () => {
  it("reads the workspace derived from the context, with the service identity", async () => {
    const s = await team();
    await f.addToGroup(s.group.id, s.member.id, s.org.id);
    gateway.versions.set(`org-${s.org.id}`, [
      {
        name: "invoice-risk",
        version: "2",
        run_id: "run-a",
        creation_timestamp: "1761350400000",
        tags: [{ key: "gate_status", value: "passed" }],
      },
      { name: "invoice-risk", version: "10", run_id: "run-b" },
      { name: "other", version: "1" },
    ]);
    gateway.versions.set(`grp-${s.group.id}`, [
      { name: "group-only", version: "1" },
    ]);

    const org = await f.call("get", `/models?${ctx(s.org.id)}`, s.memberCookie);
    expect(org.status).toBe(200);
    expect(org.body.workspace).toBe(`org-${s.org.id}`);
    expect(org.body.mlflowUrl).toBe(
      `https://mlflow.example.test/?context=org-${s.org.id}`,
    );
    expect(org.body.models.map((m: { name: string }) => m.name)).toEqual([
      "invoice-risk",
      "other",
    ]);
    expect(org.body.models[0].versions).toEqual([
      { version: "10", runId: "run-b", createdAt: null, gateStatus: null },
      {
        version: "2",
        runId: "run-a",
        createdAt: "2025-10-25T00:00:00.000Z",
        gateStatus: "passed",
      },
    ]);
    expect(gateway.calls.at(-1)).toMatchObject({
      authorization: `Bearer ${GATEWAY_TOKEN}`,
      workspace: `org-${s.org.id}`,
    });

    const group = await f.call(
      "get",
      `/models?${ctx(s.org.id, s.group.id)}`,
      s.memberCookie,
    );
    expect(group.body.workspace).toBe(`grp-${s.group.id}`);
    expect(group.body.models).toHaveLength(1);
    expect(gateway.calls.at(-1)?.workspace).toBe(`grp-${s.group.id}`);
  });

  it("never lets the client choose the workspace", async () => {
    const s = await team();
    const response = await f.call(
      "get",
      `/models?${ctx(s.org.id)}&workspace=org-someone-else`,
      s.memberCookie,
    );
    expect(response.status).toBe(400);
    expect(gateway.calls).toEqual([]);
  });

  it("answers 503 when the registry is down and leaves the rest of the app working", async () => {
    const s = await team();
    gateway.down = true;
    const response = await f.call(
      "get",
      `/models?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    expect((await f.call("get", "/auth/profile", s.memberCookie)).status).toBe(
      200,
    );
  });

  it("answers 503 while the services are not configured", async () => {
    use(buildApp({}, false));
    const s = await team();
    expect(
      (await f.call("get", `/models?${ctx(s.org.id)}`, s.memberCookie)).status,
    ).toBe(503);
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id),
        )
      ).status,
    ).toBe(503);
    expect(
      await prisma.deployment.count({ where: { organizationId: s.org.id } }),
    ).toBe(0);
  });
});

describe("MLOPS-05 deploy", () => {
  it("stores a passing deployment as ACTIVE with run id, metrics and audit", async () => {
    const s = await team();
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );

    expect(response.status).toBe(201);
    const deployment = response.body.deployment;
    expect(deployment).toMatchObject({
      organizationId: s.org.id,
      groupId: null,
      workspace: `org-${s.org.id}`,
      registeredModel: "invoice-risk",
      version: "3",
      runId: "run-0001",
      status: "ACTIVE",
      inferenceEnabled: false,
      loaded: true,
      createdByUserId: s.deployer.id,
    });
    expect(deployment.gate).toMatchObject({
      passed: true,
      reasons: [],
      metrics: { auc: 0.82, minAuc: 0.7 },
    });
    const put = modelApi.calls.find((call) => call.method === "PUT")!;
    expect(put.path).toBe(`/deployments/${deployment.id}`);
    expect(put.body).toEqual({
      workspace: `org-${s.org.id}`,
      registeredModel: "invoice-risk",
      version: "3",
    });
    const row = await prisma.deployment.findUniqueOrThrow({
      where: { id: deployment.id },
    });
    expect(row.scopeKey).toBe("organization");
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: deployment.id },
    });
    expect(events.map((event) => event.type)).toEqual(["DEPLOYED"]);
    expect(events[0]!.actorUserId).toBe(s.deployer.id);

    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([
      deployment.id,
    ]);
    expect(list.body.limits).toEqual({
      activeCount: 1,
      maxActive: 3,
      maxChecksPerHour: 10,
    });
    expect(list.body.modelApiAvailable).toBe(true);
  });

  it("deploys into a group scope with the group workspace", async () => {
    const s = await team();
    await f.addToGroup(s.group.id, s.deployer.id, s.org.id);
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { groupId: s.group.id }),
    );
    expect(response.status).toBe(201);
    expect(response.body.deployment).toMatchObject({
      groupId: s.group.id,
      workspace: `grp-${s.group.id}`,
    });
    const row = await prisma.deployment.findUniqueOrThrow({
      where: { id: response.body.deployment.id },
    });
    expect(row.scopeKey).toBe(s.group.id);
    // The organization context does not list it.
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(list.body.items).toEqual([]);
  });

  it("keeps a rejected version as FAILED with its reasons and metrics", async () => {
    const s = await team();
    modelApi.putMode = "fail";
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );

    expect(response.status).toBe(201);
    const deployment = response.body.deployment;
    expect(deployment.status).toBe("FAILED");
    expect(deployment.inferenceEnabled).toBe(false);
    expect(deployment.runId).toBe("run-0001");
    expect(deployment.gate.passed).toBe(false);
    expect(deployment.gate.reasons).toEqual([
      {
        code: "AUC_BELOW_MIN",
        message: "AUC 0.61 is below the minimum 0.70",
        detail: { auc: 0.61, minAuc: 0.7 },
      },
    ]);
    expect(deployment.gate.metrics).toMatchObject({ auc: 0.61, minAuc: 0.7 });
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: deployment.id },
    });
    expect(events.map((event) => event.type)).toEqual(["DEPLOY_FAILED"]);
    // A failed attempt holds no slot and can be repeated for the same version.
    modelApi.putMode = "pass";
    const retry = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(retry.status).toBe(201);
    expect(retry.body.deployment.status).toBe("ACTIVE");
  });

  it("refuses to deploy the same live version twice", async () => {
    const s = await team();
    const first = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(first.status).toBe(201);
    const second = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
  });

  it("validates the body: integer version only, no unknown fields", async () => {
    const s = await team();
    for (const body of [
      deployBody(s.org.id, { version: "latest" }),
      deployBody(s.org.id, { version: "0" }),
      deployBody(s.org.id, { workspace: "org-x" }),
      deployBody(s.org.id, { registeredModel: "" }),
      { ...deployBody(s.org.id), organizationId: "nope" },
    ]) {
      const response = await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        body,
      );
      expect(response.status).toBe(400);
    }
    expect(modelApi.calls).toEqual([]);
  });

  it("enforces the active cap per scope (default 3) and frees a slot on removal", async () => {
    const s = await team();
    const ids: string[] = [];
    for (const version of ["1", "2", "3"]) {
      const ok = await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        deployBody(s.org.id, { version }),
      );
      expect(ok.status).toBe(201);
      ids.push(ok.body.deployment.id);
    }
    const fourth = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version: "4" }),
    );
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe("DEPLOYMENT_LIMIT");
    expect(fourth.body.error.message).toContain("3");
    // The rejected request never reached the gate.
    expect(modelApi.calls.filter((call) => call.method === "PUT")).toHaveLength(
      3,
    );

    // Another scope has its own budget.
    await f.addToGroup(s.group.id, s.deployer.id, s.org.id);
    const group = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { groupId: s.group.id, version: "4" }),
    );
    expect(group.status).toBe(201);

    const removed = await f.call(
      "delete",
      `/deployments/${ids[0]}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(removed.status).toBe(200);
    const again = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version: "4" }),
    );
    expect(again.status).toBe(201);
  });

  it("makes the cap configurable", async () => {
    use(buildApp({ maxActiveDeployments: 1 }));
    const s = await team();
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id),
        )
      ).status,
    ).toBe(201);
    const second = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version: "4" }),
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("DEPLOYMENT_LIMIT");
  });

  it("never exceeds the cap under concurrent deploys", async () => {
    const s = await team();
    modelApi.putMode = "slow";
    const responses = await Promise.all(
      ["1", "2", "3", "4", "5", "6"].map((version) =>
        f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id, { version }),
        ),
      ),
    );
    const created = responses.filter((response) => response.status === 201);
    expect(created.length).toBeLessThanOrEqual(3);
    for (const response of responses) {
      expect([201, 409, 503]).toContain(response.status);
    }
    expect(
      await prisma.deployment.count({
        where: {
          organizationId: s.org.id,
          status: { in: ["ACTIVE", "CHECKING"] },
        },
      }),
    ).toBe(created.length);
  });

  it("rate-limits gate runs per scope per hour, failures included, with Retry-After", async () => {
    use(buildApp({ maxDeployChecksPerHour: 2, maxActiveDeployments: 10 }));
    const s = await team();
    modelApi.putMode = "fail";
    for (const version of ["1", "2"]) {
      expect(
        (
          await f.call(
            "post",
            "/deployments",
            s.deployerCookie,
            deployBody(s.org.id, { version }),
          )
        ).status,
      ).toBe(201);
    }
    const third = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version: "3" }),
    );
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("RATE_LIMITED");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    expect(modelApi.calls.filter((call) => call.method === "PUT")).toHaveLength(
      2,
    );

    // Another scope is unaffected.
    await f.addToGroup(s.group.id, s.deployer.id, s.org.id);
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id, { groupId: s.group.id }),
        )
      ).status,
    ).toBe(201);
    // Attempts older than an hour stop counting.
    await prisma.deployment.updateMany({
      where: { organizationId: s.org.id, scopeKey: "organization" },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id, { version: "3" }),
        )
      ).status,
    ).toBe(201);
  });

  it("leaves no trace (or rate-limit cost) when nothing ran: no connection, or no capacity", async () => {
    use(buildApp({ maxDeployChecksPerHour: 1 }));
    const s = await team();
    modelApi.putMode = "capacity";
    const full = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("DEPLOYMENT_LIMIT");
    modelApi.putMode = "pass";

    // Nothing listens on port 1: the connection fails before any response.
    use(
      createApp(database, auth, {
        models: createModelsService(prisma, {
          config: { ...defaultModelsConfig(), maxDeployChecksPerHour: 1 },
          modelApi: createModelApiClient({
            url: "http://127.0.0.1:1",
            token: MODEL_API_TOKEN,
          }),
        }),
      }),
    );
    const refused = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(refused.status).toBe(503);
    expect(
      await prisma.deployment.count({ where: { organizationId: s.org.id } }),
    ).toBe(0);
    // The rest of the app is unaffected and the budget is intact.
    expect(
      (await f.call("get", "/auth/profile", s.deployerCookie)).status,
    ).toBe(200);
    use(buildApp({ maxDeployChecksPerHour: 1 }));
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id),
        )
      ).status,
    ).toBe(201);
  });

  it("keeps an attempt that got a response as FAILED, counted toward the hourly limit", async () => {
    use(buildApp({ maxDeployChecksPerHour: 2 }));
    const s = await team();
    // 502 and 503 answers: the gate may have run.
    modelApi.down = true;
    const first = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(first.status).toBe(503);
    modelApi.down = false;
    modelApi.putMode = "down";
    const second = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(second.status).toBe(503);

    const rows = await prisma.deployment.findMany({
      where: { organizationId: s.org.id },
      include: { events: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("FAILED");
      expect(row.gateReport).toMatchObject({
        reasons: [{ code: "MODEL_API_ERROR" }],
      });
      expect(row.events.map((event) => event.type)).toEqual(["DEPLOY_FAILED"]);
    }
    modelApi.putMode = "pass";
    const limited = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(limited.status).toBe(429);
  });

  it("marks a timed-out check FAILED (CHECK_TIMEOUT), unloads what finished loading, and reconciles later", async () => {
    use(
      createApp(database, auth, {
        models: createModelsService(prisma, {
          config: defaultModelsConfig(),
          modelApi: createModelApiClient(
            { url: modelApi.url, token: MODEL_API_TOKEN },
            { deployTimeoutMs: 100 },
          ),
        }),
      }),
    );
    const s = await team();
    modelApi.putMode = "load-then-hang";
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(response.status).toBe(503);
    const [row] = await prisma.deployment.findMany({
      where: { organizationId: s.org.id },
    });
    expect(row!.status).toBe("FAILED");
    expect(row!.gateReport).toMatchObject({
      reasons: [{ code: "CHECK_TIMEOUT" }],
    });
    expect(modelApi.loaded.has(row!.id)).toBe(false);

    // The Model API finishes loading after the unload: the next maintenance
    // pass (never a GET) unloads the orphan.
    await waitFor(
      () => modelApi.loaded.has(row!.id),
      "the Model API to finish loading the abandoned model",
    );
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.status).toBe(200);
    // A read never unloads anything.
    expect(modelApi.loaded.has(row!.id)).toBe(true);
    await reconcileNow();
    expect(modelApi.loaded.has(row!.id)).toBe(false);
  });

  it("discards CHECKING rows that never completed so they stop holding a slot", async () => {
    use(buildApp({ maxActiveDeployments: 1 }));
    const s = await team();
    const stale = await prisma.deployment.create({
      data: {
        organizationId: s.org.id,
        scopeKey: "organization",
        workspace: `org-${s.org.id}`,
        registeredModel: "old",
        version: "1",
        status: "CHECKING",
        createdByUserId: s.deployer.id,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    expect(response.status).toBe(201);
    const swept = await prisma.deployment.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(swept.status).toBe("FAILED");
    expect(swept.gateReport).toMatchObject({
      reasons: [{ code: "CHECK_INTERRUPTED" }],
    });
  });
});

describe("MLOPS-05 orphaned models and audit trail", () => {
  const reference = { workspace: "w", registeredModel: "m", version: "1" };

  it("unloads loaded ids whose row is FAILED, INACTIVE or missing, never ACTIVE or foreign ids", async () => {
    const s = await team();
    await isolateReconcile(s.org.id);
    const make = (status: "FAILED" | "INACTIVE" | "ACTIVE", model: string) =>
      prisma.deployment.create({
        data: {
          organizationId: s.org.id,
          scopeKey: "organization",
          workspace: `org-${s.org.id}`,
          registeredModel: model,
          version: "1",
          status,
          createdByUserId: s.deployer.id,
        },
      });
    const failed = await make("FAILED", "a");
    const inactive = await make("INACTIVE", "b");
    const active = await make("ACTIVE", "c");
    const missing = crypto.randomUUID();
    for (const id of [
      failed.id,
      inactive.id,
      active.id,
      missing,
      "legacy-id",
    ]) {
      modelApi.loaded.set(id, reference);
    }

    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.status).toBe(200);
    // The read does not touch the Model API's loaded set (CR-508).
    expect(modelApi.loaded.size).toBe(5);
    const result = await reconcileNow();
    expect(result.unloaded).toBeGreaterThanOrEqual(3);
    expect([...modelApi.loaded.keys()].sort()).toEqual(
      [active.id, "legacy-id"].sort(),
    );
  });

  it("unloads a stale check on the sweep and records its event without an actor", async () => {
    const s = await team();
    const stale = await prisma.deployment.create({
      data: {
        organizationId: s.org.id,
        scopeKey: "organization",
        workspace: `org-${s.org.id}`,
        registeredModel: "old",
        version: "1",
        status: "CHECKING",
        createdByUserId: s.deployer.id,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    modelApi.loaded.set(stale.id, reference);
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.status).toBe(200);
    // A GET leaves the stale CHECKING row and its model alone.
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id: stale.id } }))
        .status,
    ).toBe("CHECKING");
    expect(modelApi.loaded.has(stale.id)).toBe(true);
    const result = await reconcileNow();
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(modelApi.loaded.has(stale.id)).toBe(false);
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: stale.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "DEPLOY_FAILED",
      actorUserId: null,
    });
  });

  it("records an event when a reload is rejected by the gate", async () => {
    const s = await team();
    const created = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    const id = created.body.deployment.id as string;
    modelApi.loaded.clear();
    modelApi.putMode = "fail";
    const service = createModelsService(prisma, {
      modelApi: createModelApiClient({
        url: modelApi.url,
        token: MODEL_API_TOKEN,
      }),
    });
    expect(await service.ensureLoaded(id)).toBe("rejected");
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => [event.type, event.actorUserId])).toEqual([
      ["DEPLOYED", s.deployer.id],
      ["DEPLOY_FAILED", null],
    ]);
  });

  it("audits which field changed and the old and new mlEnabled value", async () => {
    const s = await team({ mlEnabled: false });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await f.call("patch", `/organizations/${s.org.id}`, s.adminCookie, {
      mlEnabled: true,
    });
    const lines = info.mock.calls.map(([line]) => String(line));
    vi.restoreAllMocks();
    const updates = lines.filter((line) => line.includes("audit.org_updated"));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!)).toMatchObject({
      changedFields: ["mlEnabled"],
      mlEnabledFrom: false,
      mlEnabledTo: true,
    });
  });
});

describe("MLOPS-05 inference toggle, removal and reconcile", () => {
  async function deployed(s: Awaited<ReturnType<typeof team>>, version = "3") {
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version }),
    );
    expect(response.status).toBe(201);
    return response.body.deployment.id as string;
  }
  const toggle = (
    s: Awaited<ReturnType<typeof team>>,
    id: string,
    inferenceEnabled: boolean,
    cookie = s.deployerCookie,
  ) =>
    f.call("patch", `/deployments/${id}?${ctx(s.org.id)}`, cookie, {
      inferenceEnabled,
    });

  it("turns scoring on and off, audits real changes only", async () => {
    const s = await team();
    const id = await deployed(s);

    const on = await toggle(s, id, true);
    expect(on.status).toBe(200);
    expect(on.body.deployment).toMatchObject({
      inferenceEnabled: true,
      status: "ACTIVE",
    });
    expect((await toggle(s, id, true)).status).toBe(200);
    const off = await toggle(s, id, false);
    expect(off.body.deployment.inferenceEnabled).toBe(false);
    // Off keeps the model loaded and the slot.
    expect(modelApi.loaded.has(id)).toBe(true);

    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.type)).toEqual([
      "DEPLOYED",
      "ACTIVATED",
      "DEACTIVATED",
    ]);
  });

  it("rejects turning on a failed, removed or unknown deployment", async () => {
    const s = await team();
    modelApi.putMode = "fail";
    const failed = (
      await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        deployBody(s.org.id),
      )
    ).body.deployment.id as string;
    modelApi.putMode = "pass";
    const removed = await deployed(s, "5");
    await f.call(
      "delete",
      `/deployments/${removed}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );

    for (const id of [failed, removed]) {
      const response = await toggle(s, id, true);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("CONFLICT");
    }
    expect((await toggle(s, crypto.randomUUID(), true)).status).toBe(404);
  });

  it("reloads a model the Model API lost (restart) when turning scoring on", async () => {
    const s = await team();
    const id = await deployed(s);
    modelApi.loaded.clear(); // Model API restarted.
    modelApi.calls.length = 0;

    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.body.items[0]).toMatchObject({
      status: "ACTIVE",
      loaded: false,
    });

    const on = await toggle(s, id, true);
    expect(on.status).toBe(200);
    expect(modelApi.calls.some((call) => call.method === "PUT")).toBe(true);
    expect(modelApi.loaded.has(id)).toBe(true);
  });

  it("marks FAILED when the reloaded model no longer passes the gate", async () => {
    const s = await team();
    const id = await deployed(s);
    modelApi.loaded.clear();
    modelApi.putMode = "fail";

    const response = await toggle(s, id, true);
    expect(response.status).toBe(409);
    const row = await prisma.deployment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
    expect(row.inferenceEnabled).toBe(false);
  });

  it("leaves the deployment unchanged (503) when the Model API is down; turning off still works", async () => {
    const s = await team();
    const id = await deployed(s);
    modelApi.down = true;

    const on = await toggle(s, id, true);
    expect(on.status).toBe(503);
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id } }))
        .inferenceEnabled,
    ).toBe(false);

    modelApi.down = false;
    await toggle(s, id, true);
    modelApi.down = true;
    const off = await toggle(s, id, false);
    expect(off.status).toBe(200);
    expect(off.body.deployment.inferenceEnabled).toBe(false);
  });

  it("reflects a quarantine after the maintenance pass: QUARANTINED, scoring off, event recorded", async () => {
    const s = await team();
    const id = await deployed(s);
    await toggle(s, id, true);
    modelApi.loaded.delete(id);
    modelApi.quarantined.add(id);

    // A read only reports it: still ACTIVE, but not loaded.
    const before = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(before.body.items[0]).toMatchObject({
      status: "ACTIVE",
      loaded: false,
    });
    expect(
      await prisma.deploymentEvent.count({
        where: { deploymentId: id, type: "QUARANTINED" },
      }),
    ).toBe(0);

    const result = await reconcileNow();
    expect(result.quarantined).toBe(1);
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.body.items[0]).toMatchObject({
      status: "QUARANTINED",
      inferenceEnabled: false,
      loaded: null,
    });
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: id, type: "QUARANTINED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBeNull();
    // It cannot be turned on again; removing it frees the version for a redeploy.
    expect((await toggle(s, id, true)).status).toBe(409);
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id),
        )
      ).status,
    ).toBe(409);
    await f.call(
      "delete",
      `/deployments/${id}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(
      (
        await f.call(
          "post",
          "/deployments",
          s.deployerCookie,
          deployBody(s.org.id),
        )
      ).status,
    ).toBe(201);
  });

  it("lists with modelApiAvailable false (never an error) when the Model API is down", async () => {
    const s = await team();
    await deployed(s);
    modelApi.down = true;
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.status).toBe(200);
    expect(list.body.modelApiAvailable).toBe(false);
    expect(list.body.items[0]).toMatchObject({
      status: "ACTIVE",
      loaded: null,
    });
  });

  it("removes a deployment: unloads, INACTIVE, scoring off, history and slot", async () => {
    const s = await team();
    const id = await deployed(s);
    await toggle(s, id, true);

    const removed = await f.call(
      "delete",
      `/deployments/${id}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.deployment).toMatchObject({
      status: "INACTIVE",
      inferenceEnabled: false,
    });
    expect(modelApi.loaded.has(id)).toBe(false);
    const again = await f.call(
      "delete",
      `/deployments/${id}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(again.status).toBe(200);
    expect(again.body.deployment.status).toBe("INACTIVE");
    const events = await prisma.deploymentEvent.findMany({
      where: { deploymentId: id, type: "REMOVED" },
    });
    expect(events).toHaveLength(1);
    // History is kept and visible; the slot is free.
    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );
    expect(list.body.items).toHaveLength(1);
    expect(list.body.limits.activeCount).toBe(0);
  });

  it("removes even when the Model API is down and unloads the orphan on the next maintenance pass", async () => {
    const s = await team();
    const id = await deployed(s);
    modelApi.down = true;
    const removed = await f.call(
      "delete",
      `/deployments/${id}?${ctx(s.org.id)}`,
      s.deployerCookie,
    );
    expect(removed.status).toBe(200);
    expect(removed.body.deployment.status).toBe("INACTIVE");
    expect(modelApi.loaded.has(id)).toBe(true);

    modelApi.down = false;
    await reconcileNow();
    expect(modelApi.loaded.has(id)).toBe(false);
  });

  it("exposes ensureLoaded for the inference worker (MLOPS-06)", async () => {
    const s = await team();
    const id = await deployed(s);
    const service = createModelsService(prisma, {
      modelApi: createModelApiClient({
        url: modelApi.url,
        token: MODEL_API_TOKEN,
      }),
    });
    expect(await service.ensureLoaded(id)).toBe("loaded");
    modelApi.loaded.clear();
    expect(await service.ensureLoaded(id)).toBe("loaded");
    expect(modelApi.loaded.has(id)).toBe(true);
    modelApi.down = true;
    modelApi.loaded.clear();
    expect(await service.ensureLoaded(id)).toBe("unavailable");
    expect(await service.ensureLoaded(crypto.randomUUID())).toBe("not_active");
  });
});

describe("MLOPS-05 review batch: interrupted deploys, retries and reconcile", () => {
  it("never leaves a deployment stuck in CHECKING when the client disconnects mid-gate, and a retry gets the current state (CR-502)", async () => {
    const s = await team();
    let release!: () => void;
    modelApi.putGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // A real client that gives up (like a proxy timing out) mid-gate.
      const payload = JSON.stringify(deployBody(s.org.id));
      const aborted = new Promise<void>((resolve) => {
        const clientRequest = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/v1/deployments",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              Cookie: s.deployerCookie,
              Origin: `http://127.0.0.1:${port}`,
            },
          },
          () => undefined,
        );
        clientRequest.on("error", () => resolve());
        clientRequest.write(payload);
        clientRequest.end();
        void waitFor(
          () => modelApi.calls.some((call) => call.method === "PUT"),
          "the gate run to start",
        ).then(() => clientRequest.destroy());
      });
      await aborted;

      // The gate is still running: the row is CHECKING and a retry is told so.
      const checking = await prisma.deployment.findFirstOrThrow({
        where: { organizationId: s.org.id },
      });
      expect(checking.status).toBe("CHECKING");
      const retryWhileChecking = await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        deployBody(s.org.id),
      );
      expect(retryWhileChecking.status).toBe(409);
      expect(retryWhileChecking.body.error.code).toBe("CONFLICT");
      expect(retryWhileChecking.body.error.fields).toEqual({
        deploymentId: checking.id,
        status: "CHECKING",
      });

      // The gate finishes after the client left: the backend completes the row.
      release();
      await waitFor(
        async () =>
          (
            await prisma.deployment.findUniqueOrThrow({
              where: { id: checking.id },
            })
          ).status === "ACTIVE",
        "the abandoned deploy to complete",
      );
      expect(modelApi.loaded.has(checking.id)).toBe(true);
      expect(
        await prisma.deploymentEvent.count({
          where: { deploymentId: checking.id, type: "DEPLOYED" },
        }),
      ).toBe(1);

      // The client's retry is idempotent: 409 with the current state, no second row.
      const retry = await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        deployBody(s.org.id),
      );
      expect(retry.status).toBe(409);
      expect(retry.body.error.fields).toEqual({
        deploymentId: checking.id,
        status: "ACTIVE",
      });
      expect(
        await prisma.deployment.count({ where: { organizationId: s.org.id } }),
      ).toBe(1);
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("counts active deployments in the database, not in the last 100 rows (CR-569)", async () => {
    const s = await team();
    // 101 historic rows (newest) plus 2 ACTIVE ones that fall off the page.
    const base = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const row = (index: number, status: "INACTIVE" | "ACTIVE") => ({
      organizationId: s.org.id,
      scopeKey: "organization",
      workspace: `org-${s.org.id}`,
      registeredModel: `model-${index}`,
      version: "1",
      status,
      createdByUserId: s.deployer.id,
      createdAt: new Date(base + index * 1000),
    });
    await prisma.deployment.createMany({
      data: [
        row(0, "ACTIVE"),
        row(1, "ACTIVE"),
        ...Array.from({ length: 101 }, (_, index) =>
          row(index + 2, "INACTIVE"),
        ),
      ],
    });

    const list = await f.call(
      "get",
      `/deployments?${ctx(s.org.id)}`,
      s.memberCookie,
    );

    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(100);
    expect(
      list.body.items.some(
        (item: { status: string }) => item.status === "ACTIVE",
      ),
    ).toBe(false);
    expect(list.body.limits.activeCount).toBe(2);
  });

  it("unloads the models of an organization whose Models section is switched off, and reloads on demand (CR-508)", async () => {
    const s = await team();
    const id = await (async () => {
      const response = await f.call(
        "post",
        "/deployments",
        s.deployerCookie,
        deployBody(s.org.id),
      );
      return response.body.deployment.id as string;
    })();
    expect(modelApi.loaded.has(id)).toBe(true);

    // Still on: reconcile leaves it alone.
    await reconcileNow();
    expect(modelApi.loaded.has(id)).toBe(true);

    await prisma.organization.update({
      where: { id: s.org.id },
      data: { mlEnabled: false },
    });
    const result = await reconcileNow();
    expect(result.unloaded).toBeGreaterThanOrEqual(1);
    expect(modelApi.loaded.has(id)).toBe(false);
    // The row keeps its history; nothing reloads it while the section is off.
    const service = createModelsService(prisma, {
      modelApi: createModelApiClient({
        url: modelApi.url,
        token: MODEL_API_TOKEN,
      }),
    });
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("ACTIVE");
    expect(await service.ensureLoaded(id)).toBe("not_active");
    expect(modelApi.loaded.has(id)).toBe(false);

    await prisma.organization.update({
      where: { id: s.org.id },
      data: { mlEnabled: true },
    });
    expect(await service.ensureLoaded(id)).toBe("loaded");
    expect(modelApi.loaded.has(id)).toBe(true);
  });

  it("reloads once for any number of concurrent ensureLoaded calls (CR-503)", async () => {
    const s = await team();
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id),
    );
    const id = response.body.deployment.id as string;
    modelApi.loaded.clear();
    modelApi.calls.length = 0;
    const service = createModelsService(prisma, {
      modelApi: createModelApiClient({
        url: modelApi.url,
        token: MODEL_API_TOKEN,
      }),
    });

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => service.ensureLoaded(id)),
    );

    expect(outcomes).toEqual(Array(6).fill("loaded"));
    expect(modelApi.calls.filter((call) => call.method === "PUT")).toHaveLength(
      1,
    );
  });

  async function deployed(s: Awaited<ReturnType<typeof team>>, version = "3") {
    const response = await f.call(
      "post",
      "/deployments",
      s.deployerCookie,
      deployBody(s.org.id, { version }),
    );
    expect(response.status).toBe(201);
    return response.body.deployment.id as string;
  }
  const toggle = (
    s: Awaited<ReturnType<typeof team>>,
    id: string,
    inferenceEnabled: boolean,
  ) =>
    f.call("patch", `/deployments/${id}?${ctx(s.org.id)}`, s.deployerCookie, {
      inferenceEnabled,
    });

  it("eagerly reloads ACTIVE deployments with scoring on that the Model API lost (CR-621)", async () => {
    const s = await team();
    await isolateReconcile(s.org.id);
    const on = await deployed(s, "1");
    const off = await deployed(s, "2");
    await toggle(s, on, true);
    modelApi.loaded.clear(); // Model API restarted.
    modelApi.calls.length = 0;

    const result = await reconcileNow();

    // The database is shared by the suite: other organizations may add to it.
    expect(result.reloaded).toBeGreaterThanOrEqual(1);
    // Only the one that scores is reloaded; scoring off waits for demand.
    expect(modelApi.loaded.has(on)).toBe(true);
    expect(modelApi.loaded.has(off)).toBe(false);
    expect(
      modelApi.calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith(`/${on}`),
      ),
    ).toHaveLength(1);
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id: on } })).status,
    ).toBe("ACTIVE");
  });

  it("does not reload when the organization has Models off, and keeps state when the reload fails (CR-621)", async () => {
    const s = await team();
    const id = await deployed(s);
    await toggle(s, id, true);
    modelApi.loaded.clear();
    modelApi.putMode = "down";
    modelApi.calls.length = 0;

    const failed = await reconcileNow();
    expect(failed.modelApiAvailable).toBe(true);
    expect(modelApi.loaded.has(id)).toBe(false);
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("ACTIVE");

    modelApi.putMode = "pass";
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { mlEnabled: false },
    });
    modelApi.calls.length = 0;
    await reconcileNow();
    expect(modelApi.loaded.has(id)).toBe(false);
    expect(
      modelApi.calls.filter(
        (call) => call.method === "PUT" && call.path.endsWith(`/${id}`),
      ),
    ).toEqual([]);
  });

  it("reloads several lost deployments in one pass (CR-621)", async () => {
    const s = await team();
    await isolateReconcile(s.org.id);
    const ids: string[] = [];
    for (const version of ["1", "2", "3"]) {
      const id = await deployed(s, version);
      await toggle(s, id, true);
      ids.push(id);
    }
    modelApi.loaded.clear();
    modelApi.putMode = "slow";
    const result = await reconcileNow();
    expect(result.reloaded).toBeGreaterThanOrEqual(3);
    expect(ids.every((id) => modelApi.loaded.has(id))).toBe(true);
  });

  it("a periodic pass only sweeps when the Model API is unreachable", async () => {
    const s = await team();
    const stale = await prisma.deployment.create({
      data: {
        organizationId: s.org.id,
        scopeKey: "organization",
        workspace: `org-${s.org.id}`,
        registeredModel: "old",
        version: "1",
        status: "CHECKING",
        createdByUserId: s.deployer.id,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    });
    modelApi.down = true;

    const result = await reconcileNow();

    expect(result).toMatchObject({ modelApiAvailable: false, quarantined: 0 });
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.deployment.findUniqueOrThrow({ where: { id: stale.id } }))
        .status,
    ).toBe("FAILED");
  });
});
