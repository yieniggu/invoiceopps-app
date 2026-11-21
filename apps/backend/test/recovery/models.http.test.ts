import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import { ApiError } from "../../src/http/errors.js";
import {
  createModelApiClient,
  ModelApiCapacityError,
  ModelApiUnavailableError,
} from "../../src/features/models/model-api-client.js";
import {
  createModelRegistryClient,
  RegistryUnavailableError,
} from "../../src/features/models/registry-client.js";
import type { ModelsService } from "../../src/features/models/services.js";
import {
  GATEWAY_TOKEN,
  MODEL_API_TOKEN,
  startFakeGateway,
  startFakeModelApi,
} from "../support/fake-model-services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333";

const profile = {
  id: "user-1",
  name: "Ada",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: false,
  memberships: [],
};

const auth: AuthService = {
  async login() {
    return {
      sessionToken: "opaque-session-token",
      user: { id: "user-1", name: "Ada", rut: "123456785" },
    };
  },
  async logout() {},
  async getProfile() {
    return profile;
  },
  async updateProfile() {
    return profile;
  },
};

const deployment = {
  id: DEPLOYMENT,
  organizationId: ORG,
  groupId: null,
  workspace: `org-${ORG}`,
  registeredModel: "invoice-risk",
  version: "3",
  runId: "run-1",
  status: "ACTIVE" as const,
  inferenceEnabled: false,
  loaded: true,
  gate: null,
  createdByUserId: "user-1",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function fakeService(): ModelsService {
  return {
    listModels: vi.fn(async () => ({
      workspace: `org-${ORG}`,
      mlflowUrl: null,
      models: [],
      truncated: false,
    })),
    listDeployments: vi.fn(async () => ({
      items: [deployment],
      limits: { activeCount: 1, maxActive: 3, maxChecksPerHour: 10 },
      modelApiAvailable: true,
    })),
    deploy: vi.fn(async () => deployment),
    setInference: vi.fn(async () => ({ deployment, changed: true })),
    remove: vi.fn(async () => ({ deployment, changed: true })),
    ensureLoaded: vi.fn(async () => "loaded" as const),
    reconcile: vi.fn(async () => ({
      swept: 0,
      quarantined: 0,
      unloaded: 0,
      reloaded: 0,
      modelApiAvailable: true,
    })),
  };
}

const appWith = (models: ModelsService | undefined = fakeService()) =>
  createApp({ isReady: async () => true }, auth, { models });

describe("MLOPS-05 models routes (session only, validated)", () => {
  it("answers 401 without a session on every operation", async () => {
    const app = appWith();
    for (const [method, path] of [
      ["get", `/api/v1/models?organizationId=${ORG}`],
      ["get", `/api/v1/deployments?organizationId=${ORG}`],
      ["post", "/api/v1/deployments"],
      ["patch", `/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`],
      ["delete", `/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`],
    ] as const) {
      const response = await request(app)[method](path).set(SAME_ORIGIN);
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects an Authorization header (API token) with 401 before any service call", async () => {
    const service = fakeService();
    const app = appWith(service);
    for (const [method, path] of [
      ["get", `/api/v1/models?organizationId=${ORG}`],
      ["get", `/api/v1/deployments?organizationId=${ORG}`],
      ["post", "/api/v1/deployments"],
      ["patch", `/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`],
      ["delete", `/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`],
    ] as const) {
      const agent = request(app);
      const response = await agent[method](path)
        .set("Host", "127.0.0.1")
        .set("Authorization", "Bearer iop_" + "a".repeat(40));
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(service.listModels).not.toHaveBeenCalled();
    expect(service.deploy).not.toHaveBeenCalled();
  });

  it("passes the context, never a client workspace, to the service", async () => {
    const service = fakeService();
    const app = appWith(service);
    const ok = await request(app)
      .get(`/api/v1/models?organizationId=${ORG}&groupId=${GROUP}`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    expect(ok.status).toBe(200);
    expect(service.listModels).toHaveBeenCalledWith("user-1", {
      organizationId: ORG,
      groupId: GROUP,
    });
    const bad = await request(app)
      .get(`/api/v1/models?organizationId=${ORG}&workspace=org-x`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    expect(bad.status).toBe(400);
    const missing = await request(app)
      .get("/api/v1/deployments")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    expect(missing.status).toBe(400);
  });

  it("validates the deploy body and answers 201 with the deployment", async () => {
    const service = fakeService();
    const app = appWith(service);
    const send = (body: unknown) =>
      request(app)
        .post("/api/v1/deployments")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(body as object);
    for (const body of [
      { organizationId: ORG, registeredModel: "m", version: "champion" },
      { organizationId: ORG, registeredModel: "m", version: "1", extra: 1 },
      { organizationId: ORG, version: "1" },
      { registeredModel: "m", version: "1" },
    ]) {
      expect((await send(body)).status).toBe(400);
    }
    const ok = await send({
      organizationId: ORG,
      registeredModel: "m",
      version: "1",
    });
    expect(ok.status).toBe(201);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(service.deploy).toHaveBeenCalledWith("user-1", {
      organizationId: ORG,
      groupId: null,
      registeredModel: "m",
      version: "1",
    });
  });

  it("answers the same 404 for a malformed deployment id and maps service errors", async () => {
    const service = fakeService();
    vi.mocked(service.remove).mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "Not found"),
    );
    const app = appWith(service);
    const malformed = await request(app)
      .delete(`/api/v1/deployments/nope?organizationId=${ORG}`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    expect(malformed.status).toBe(404);
    const missing = await request(app)
      .delete(`/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(malformed.body);
    expect(service.remove).toHaveBeenCalledTimes(1);

    const body = await request(app)
      .patch(`/api/v1/deployments/${DEPLOYMENT}?organizationId=${ORG}`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ inferenceEnabled: "yes" });
    expect(body.status).toBe(400);
  });

  it("documents the operations in OpenAPI with the Models tag", async () => {
    const document = (await request(appWith()).get("/openapi.json")).body;
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/models",
        "/api/v1/deployments",
        "/api/v1/deployments/{deploymentId}",
      ]),
    );
    expect(document.paths["/api/v1/deployments"].post.tags).toEqual(["Models"]);
    expect(
      document.paths["/api/v1/deployments/{deploymentId}"].delete,
    ).toBeDefined();
  });
});

describe("Model API client against a fake Model API", () => {
  it("sends the service token, maps pass, reject, capacity and outage", async () => {
    const fake = await startFakeModelApi();
    try {
      const client = createModelApiClient({
        url: fake.url,
        token: MODEL_API_TOKEN,
      });
      const ref = { workspace: "org-x", registeredModel: "m", version: "1" };

      const loaded = await client.deploy("dep-1", ref);
      expect(loaded).toMatchObject({
        kind: "loaded",
        report: { passed: true, runId: "run-0001", metrics: { auc: 0.82 } },
      });
      expect(fake.calls[0]).toMatchObject({
        method: "PUT",
        path: "/deployments/dep-1",
        authorization: `Bearer ${MODEL_API_TOKEN}`,
        body: ref,
      });
      expect(await client.state()).toEqual({
        loaded: new Set(["dep-1"]),
        quarantined: new Set(),
      });

      fake.putMode = "fail";
      const rejected = await client.deploy("dep-2", ref);
      expect(rejected).toMatchObject({
        kind: "rejected",
        report: {
          passed: false,
          featureSchemaVersion: "invoice-features-v2",
          reasons: [
            { code: "AUC_BELOW_MIN", detail: { auc: 0.61, minAuc: 0.7 } },
          ],
        },
      });

      fake.putMode = "capacity";
      await expect(client.deploy("dep-3", ref)).rejects.toBeInstanceOf(
        ModelApiCapacityError,
      );
      fake.putMode = "down";
      await expect(client.deploy("dep-3", ref)).rejects.toBeInstanceOf(
        ModelApiUnavailableError,
      );
      await client.unload("dep-1");
      expect(fake.loaded.has("dep-1")).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("treats a wrong service token and an unreachable host as unavailable", async () => {
    const fake = await startFakeModelApi();
    try {
      const wrong = createModelApiClient({
        url: fake.url,
        token: "x".repeat(40),
      });
      await expect(wrong.state()).rejects.toBeInstanceOf(
        ModelApiUnavailableError,
      );
      await fake.close();
      const dead = createModelApiClient({
        url: fake.url,
        token: MODEL_API_TOKEN,
      });
      await expect(dead.state()).rejects.toBeInstanceOf(
        ModelApiUnavailableError,
      );
    } catch (error) {
      await fake.close().catch(() => undefined);
      throw error;
    }
  });
});

describe("MLflow registry client against a fake gateway", () => {
  it("sends the service identity and workspace, groups and sorts versions", async () => {
    const gateway = await startFakeGateway();
    try {
      gateway.versions.set("grp-abc", [
        { name: "b", version: "1" },
        { name: "a", version: "2", run_id: "r2" },
        {
          name: "a",
          version: "11",
          run_id: "r11",
          tags: [{ key: "gate_status", value: "passed" }],
        },
        { name: "ignored", version: "latest" },
      ]);
      const client = createModelRegistryClient({
        url: gateway.url,
        token: GATEWAY_TOKEN,
      });
      const result = await client.listModels("grp-abc");
      expect(result.truncated).toBe(false);
      expect(result.models.map((model) => model.name)).toEqual(["a", "b"]);
      expect(result.models[0]!.versions.map((v) => v.version)).toEqual([
        "11",
        "2",
      ]);
      expect(result.models[0]!.versions[0]!.gateStatus).toBe("passed");
      expect(gateway.calls[0]).toMatchObject({
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        workspace: "grp-abc",
      });
      gateway.down = true;
      await expect(client.listModels("grp-abc")).rejects.toBeInstanceOf(
        RegistryUnavailableError,
      );
    } finally {
      await gateway.close();
    }
  });
});
