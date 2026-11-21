import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaPg } from "@prisma/adapter-pg";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { InvoiceCreateRequestSchema } from "../../src/features/invoices/schemas.js";
import { createInvoiceCreateService } from "../../src/features/invoices/services.js";
import { createModelApiClient } from "../../src/features/models/model-api-client.js";
import { createModelsService } from "../../src/features/models/services.js";
import {
  DEFAULT_PREDICTION_WORKER_CONFIG,
  type PredictionWorkerConfig,
} from "../../src/features/predictions/config.js";
import { readPredictionQueueMetrics } from "../../src/features/predictions/metrics.js";
import {
  createPredictionWorker,
  MAX_PRIOR_INVOICES,
} from "../../src/features/predictions/worker.js";
import {
  MODEL_API_TOKEN,
  startFakeModelApi,
  type FakeModelApi,
} from "../support/fake-model-services.js";
import { waitFor } from "../support/wait-for.js";
import { supplierKey } from "../../src/supplier-key.js";
import { backfillSupplierKeys } from "../../src/supplier-key-backfill.js";
import { ALL_FLAGS, membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const f = membershipFixtures({ prisma, client, auth, app, url });

let modelApi: FakeModelApi;

beforeAll(async () => {
  await client.connect();
  modelApi = await startFakeModelApi();
});
afterAll(async () => {
  await modelApi.close();
  await client.end();
  await prisma.$disconnect();
});
beforeEach(async () => {
  // The database is shared by every test: leftovers must not be claimed.
  await prisma.invoicePrediction.updateMany({
    where: { status: "PENDING" },
    data: { status: "SKIPPED" },
  });
  modelApi.calls.length = 0;
  modelApi.loaded.clear();
  modelApi.quarantined.clear();
  modelApi.putMode = "pass";
  modelApi.predictMode = "ok";
  modelApi.predictDelayMs = 0;
  modelApi.probability = 0.37;
  modelApi.down = false;
});

const client_ = () =>
  createModelApiClient({ url: modelApi.url, token: MODEL_API_TOKEN });

/** A worker with a controllable clock; every test drives it with runOnce. */
function makeWorker(overrides: Partial<PredictionWorkerConfig> = {}) {
  // The real clock plus a manual offset, so jobs created now are due.
  const clock = { offset: 0 };
  const config = {
    ...DEFAULT_PREDICTION_WORKER_CONFIG,
    pollIntervalMs: 20,
    maxAttempts: 3,
    retryBaseMs: 1_000,
    ...overrides,
  };
  const api = client_();
  const worker = createPredictionWorker(prisma, {
    config,
    modelApi: api,
    models: createModelsService(prisma, { modelApi: api }),
    now: () => new Date(Date.now() + clock.offset),
    random: () => 1,
  });
  return {
    worker,
    /** Moves the worker's clock past every backoff and lease. */
    advance: (ms = 3_600_000) => {
      clock.offset += ms;
    },
  };
}

async function world(options: { mlEnabled?: boolean } = {}) {
  const s = await f.scenario();
  await prisma.organization.update({
    where: { id: s.org.id },
    data: { mlEnabled: options.mlEnabled ?? true },
  });
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: ALL_FLAGS,
  });
  return {
    ...s,
    memberCookie: await f.cookieFor(s.member),
    outsiderCookie: await f.cookieFor(s.outsider),
  };
}
type World = Awaited<ReturnType<typeof world>>;

async function deployment(
  s: World,
  options: {
    group?: boolean;
    status?: "ACTIVE" | "INACTIVE";
    inferenceEnabled?: boolean;
    organizationId?: string;
    loaded?: boolean;
    version?: string;
  } = {},
) {
  const organizationId = options.organizationId ?? s.org.id;
  const row = await prisma.deployment.create({
    data: {
      organizationId,
      groupId: options.group ? s.group.id : null,
      scopeKey: options.group ? s.group.id : "organization",
      workspace: options.group ? `grp-${s.group.id}` : `org-${organizationId}`,
      registeredModel: "invoice-risk",
      version: options.version ?? "3",
      runId: "run-0001",
      status: options.status ?? "ACTIVE",
      inferenceEnabled: options.inferenceEnabled ?? true,
      createdByUserId: s.member.id,
    },
  });
  if (options.loaded ?? (options.status ?? "ACTIVE") === "ACTIVE") {
    modelApi.loaded.set(row.id, {
      workspace: row.workspace,
      registeredModel: row.registeredModel,
      version: row.version,
    });
  }
  return row;
}

function createInvoice(
  s: World,
  overrides: Record<string, unknown> = {},
  group = false,
) {
  return f
    .call("post", "/invoices", s.memberCookie, {
      organizationId: s.org.id,
      ...(group ? { groupId: s.group.id } : {}),
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
      ...overrides,
    })
    .set("Idempotency-Key", `key-${randomUUID()}`);
}

const predictionsOf = (invoiceId: string) =>
  prisma.invoicePrediction.findMany({
    where: { invoiceId },
    orderBy: { createdAt: "asc" },
  });
const predictCalls = () =>
  modelApi.calls.filter((call) => call.path.endsWith("/predict"));

async function seedInvoice(
  s: World,
  data: {
    supplierName: string;
    createdAt: Date;
    groupId?: string | null;
    organizationId?: string;
    deletedAt?: Date | null;
    businessStatus?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
    amountPesos?: number;
  },
) {
  const groupId = data.groupId === undefined ? null : data.groupId;
  return prisma.invoice.create({
    data: {
      organizationId: data.organizationId ?? s.org.id,
      groupId,
      scopeKey: groupId ?? "organization",
      businessId: `SEED-${randomUUID()}`,
      supplierName: data.supplierName,
      supplierKey: supplierKey(data.supplierName),
      amountPesos: data.amountPesos ?? 1000,
      currency: "CLP",
      issuedOn: new Date("2026-01-01T00:00:00Z"),
      dueOn: new Date("2026-02-01T00:00:00Z"),
      businessStatus: data.businessStatus ?? "APPROVED",
      createdByUserId: s.member.id,
      createdAt: data.createdAt,
      deletedAt: data.deletedAt ?? null,
      deletedByUserId: data.deletedAt ? s.member.id : null,
    },
  });
}

describe("MLOPS-06 outbox on invoice creation", () => {
  it("enqueues one job per eligible deployment: the invoice's own scope plus the organization's", async () => {
    const s = await world();
    const orgDeployment = await deployment(s);
    const groupDeployment = await deployment(s, { group: true });
    await deployment(s, { inferenceEnabled: false, version: "4" });
    await deployment(s, { status: "INACTIVE", version: "5" });
    const other = await f.makeOrg("other");
    await prisma.organization.update({
      where: { id: other.id },
      data: { mlEnabled: true },
    });
    await deployment(s, { organizationId: other.id, version: "6" });

    const orgInvoice = await createInvoice(s);
    expect(orgInvoice.status).toBe(201);
    const orgJobs = await predictionsOf(orgInvoice.body.invoice.id);
    expect(orgJobs).toHaveLength(1);
    expect(orgJobs[0]).toMatchObject({
      deploymentId: orgDeployment.id,
      organizationId: s.org.id,
      scopeKey: "organization",
      status: "PENDING",
      attempts: 0,
      probability: null,
      registeredModel: "invoice-risk",
      modelVersion: "3",
    });

    const groupInvoice = await createInvoice(s, {}, true);
    expect(groupInvoice.status).toBe(201);
    const groupJobs = await predictionsOf(groupInvoice.body.invoice.id);
    expect(groupJobs.map((job) => job.deploymentId).sort()).toEqual(
      [groupDeployment.id, orgDeployment.id].sort(),
    );
    // Every row carries the invoice's scope.
    expect(groupJobs.map((job) => job.scopeKey)).toEqual([
      s.group.id,
      s.group.id,
    ]);
    // Creation never talks to the Model API.
    expect(modelApi.calls).toEqual([]);
  });

  it("scores an organization-level invoice only with organization deployments", async () => {
    const s = await world();
    const orgDeployment = await deployment(s);
    await deployment(s, { group: true });
    const created = await createInvoice(s);
    expect(created.status).toBe(201);
    const jobs = await predictionsOf(created.body.invoice.id);
    expect(jobs.map((job) => job.deploymentId)).toEqual([orgDeployment.id]);
  });

  it("never scores a group invoice with another group's deployment", async () => {
    const s = await world();
    const orgDeployment = await deployment(s);
    const otherGroup = await prisma.group.create({
      data: { organizationId: s.org.id, name: `otro-${randomUUID()}` },
    });
    const foreign = await prisma.deployment.create({
      data: {
        organizationId: s.org.id,
        groupId: otherGroup.id,
        scopeKey: otherGroup.id,
        workspace: `grp-${otherGroup.id}`,
        registeredModel: "invoice-risk",
        version: "9",
        runId: "run-0009",
        status: "ACTIVE",
        inferenceEnabled: true,
        createdByUserId: s.member.id,
      },
    });
    const created = await createInvoice(s, {}, true);
    expect(created.status).toBe(201);
    const ids = (await predictionsOf(created.body.invoice.id)).map(
      (job) => job.deploymentId,
    );
    expect(ids).toEqual([orgDeployment.id]);
    expect(ids).not.toContain(foreign.id);
  });

  it("excludes inactive or inference-disabled organization deployments from a group invoice", async () => {
    const s = await world();
    const groupDeployment = await deployment(s, { group: true });
    await deployment(s, { inferenceEnabled: false, version: "4" });
    await deployment(s, { status: "INACTIVE", version: "5" });
    const created = await createInvoice(s, {}, true);
    expect(created.status).toBe(201);
    const jobs = await predictionsOf(created.body.invoice.id);
    expect(jobs.map((job) => job.deploymentId)).toEqual([groupDeployment.id]);
  });

  it("enqueues nothing while mlEnabled is off or without eligible deployments", async () => {
    const off = await world({ mlEnabled: false });
    await deployment(off);
    const created = await createInvoice(off);
    expect(created.status).toBe(201);
    expect(await predictionsOf(created.body.invoice.id)).toEqual([]);

    const none = await world();
    const bare = await createInvoice(none);
    expect(bare.status).toBe(201);
    expect(await predictionsOf(bare.body.invoice.id)).toEqual([]);
  });

  it("does not score invoices created before the deployment was activated", async () => {
    const s = await world();
    const before = await createInvoice(s);
    await deployment(s);
    const { worker } = makeWorker();
    await worker.runOnce();
    expect(await predictionsOf(before.body.invoice.id)).toEqual([]);
    expect(modelApi.calls).toEqual([]);
  });

  it("replays an idempotent creation without a second job", async () => {
    const s = await world();
    await deployment(s);
    const key = `key-${randomUUID()}`;
    const payload = {
      organizationId: s.org.id,
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 1,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
    };
    const first = await f
      .call("post", "/invoices", s.memberCookie, payload)
      .set("Idempotency-Key", key);
    const second = await f
      .call("post", "/invoices", s.memberCookie, payload)
      .set("Idempotency-Key", key);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(await predictionsOf(first.body.invoice.id)).toHaveLength(1);
  });

  it("enforces one row per (invoice, deployment)", async () => {
    const s = await world();
    const d = await deployment(s);
    const created = await createInvoice(s);
    await expect(
      prisma.invoicePrediction.create({
        data: {
          invoiceId: created.body.invoice.id,
          deploymentId: d.id,
          organizationId: s.org.id,
          scopeKey: "organization",
          registeredModel: "invoice-risk",
          modelVersion: "3",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("MLOPS-06 worker", () => {
  it("stores version, run and probability, and the detail shows them", async () => {
    const s = await world();
    const d1 = await deployment(s);
    const d2 = await deployment(s, { version: "4" });
    const created = await createInvoice(s);
    const { worker } = makeWorker();
    expect(await worker.runOnce()).toBe(2);

    const rows = await predictionsOf(created.body.invoice.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: "SUCCEEDED",
        probability: 0.37,
        runId: "run-0001",
        featureSchemaVersion: "invoice-features-v2",
        attempts: 1,
        lastErrorCode: null,
      });
    }
    expect(rows.map((row) => row.modelVersion).sort()).toEqual(["3", "4"]);
    expect(
      predictCalls()
        .map((call) => call.path)
        .sort(),
    ).toEqual(
      [`/deployments/${d1.id}/predict`, `/deployments/${d2.id}/predict`].sort(),
    );
    const sent = predictCalls()[0]!.body as {
      invoice: Record<string, unknown>;
      priorInvoices: unknown[];
    };
    expect(sent.invoice).toMatchObject({
      supplierName: "Proveedor local",
      amountPesos: 12500,
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
    });
    expect(sent.invoice.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    // The label is never sent.
    expect(sent.invoice).not.toHaveProperty("businessStatus");
    expect(sent.priorInvoices).toEqual([]);

    const detail = await f.call(
      "get",
      `/invoices/${created.body.invoice.id}?organizationId=${s.org.id}`,
      s.memberCookie,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.predictions).toHaveLength(2);
    expect(detail.body.predictions[0]).toMatchObject({
      registeredModel: "invoice-risk",
      runId: "run-0001",
      probability: 0.37,
      status: "SUCCEEDED",
      errorCode: null,
    });
    // Reprocessing a finished job is a no-op.
    expect(await worker.runOnce()).toBe(0);
    expect(predictCalls()).toHaveLength(2);
  });

  it("creates the invoice normally with the Model API failing, retries with backoff, then FAILED", async () => {
    const s = await world();
    await deployment(s);
    // A 500 is an answer, not an outage: every retry consumes an attempt.
    modelApi.predictMode = "error";
    const created = await createInvoice(s);
    expect(created.status).toBe(201);
    // Creating the invoice never calls the Model API (it is only a job insert).
    expect(modelApi.calls).toHaveLength(0);
    const id = created.body.invoice.id as string;
    const { worker, advance } = makeWorker();

    expect(await worker.runOnce()).toBe(1);
    let [row] = await predictionsOf(id);
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastErrorCode: "MODEL_API_ERROR",
    });
    // Backed off: not due again yet.
    expect(await worker.runOnce()).toBe(0);

    advance();
    await worker.runOnce();
    advance();
    await worker.runOnce();
    [row] = await predictionsOf(id);
    expect(row).toMatchObject({
      status: "FAILED",
      attempts: 3,
      lastErrorCode: "MODEL_API_ERROR",
    });
    // The invoice is untouched and still readable (failed state shown).
    const detail = await f.call(
      "get",
      `/invoices/${id}?organizationId=${s.org.id}`,
      s.memberCookie,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.predictions[0]).toMatchObject({
      status: "FAILED",
      errorCode: "MODEL_API_ERROR",
    });
  });

  it("completes the pending job when the Model API comes back", async () => {
    const s = await world();
    await deployment(s);
    modelApi.down = true;
    const created = await createInvoice(s);
    const { worker, advance } = makeWorker();
    await worker.runOnce();
    modelApi.down = false;
    advance();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    // The outage consumed no attempt: the job succeeds on its first real one.
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      unavailableRetries: 1,
    });
  });

  it("does not retry a request the Model API rejects as invalid", async () => {
    const s = await world();
    await deployment(s);
    modelApi.predictMode = "invalid";
    const created = await createInvoice(s);
    const { worker } = makeWorker();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    expect(row).toMatchObject({
      status: "FAILED",
      attempts: 1,
      lastErrorCode: "INVALID_INPUT",
    });
  });

  it.each(["too-large", "out-of-range"] as const)(
    "fails terminally with INVALID_INPUT when the Model API answers %s",
    async (mode) => {
      const s = await world();
      await deployment(s);
      modelApi.predictMode = mode;
      const created = await createInvoice(s);
      const { worker } = makeWorker();
      await worker.runOnce();
      const [row] = await predictionsOf(created.body.invoice.id);
      expect(row).toMatchObject({
        status: "FAILED",
        attempts: 1,
        lastErrorCode: "INVALID_INPUT",
      });
    },
  );

  it("waits without consuming an attempt on a 503 BUSY", async () => {
    const s = await world();
    await deployment(s);
    modelApi.predictMode = "busy";
    const created = await createInvoice(s);
    const { worker } = makeWorker();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 0,
      unavailableRetries: 1,
      lastErrorCode: "MODEL_API_UNAVAILABLE",
    });
  });

  it("retries a 503 INFERENCE_UNAVAILABLE", async () => {
    const s = await world();
    await deployment(s);
    modelApi.predictMode = "unavailable";
    const created = await createInvoice(s);
    const { worker } = makeWorker();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 0,
      unavailableRetries: 1,
      lastErrorCode: "INFERENCE_UNAVAILABLE",
    });
  });

  it("reloads a model the Model API lost (DEPLOYMENT_NOT_LOADED) through ensureLoaded and retries", async () => {
    const s = await world();
    const d = await deployment(s);
    const created = await createInvoice(s);
    modelApi.loaded.clear(); // Model API restarted.
    modelApi.calls.length = 0;
    const { worker } = makeWorker();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    expect(row).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(modelApi.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      [
        `POST /deployments/${d.id}/predict`,
        "GET /deployments",
        `PUT /deployments/${d.id}`,
        `POST /deployments/${d.id}/predict`,
      ],
    );
  });

  it("retries when the reload cannot happen (Model API down during ensureLoaded)", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    modelApi.loaded.clear();
    modelApi.putMode = "down";
    const { worker } = makeWorker();
    await worker.runOnce();
    const [row] = await predictionsOf(created.body.invoice.id);
    // Unavailability keeps the job waiting and consumes no attempt (CR-501).
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 0,
      unavailableRetries: 1,
      lastErrorCode: "MODEL_API_UNAVAILABLE",
    });
  });

  it("skips jobs whose deployment was deactivated, removed or whose organization turned ML off", async () => {
    const s = await world();
    const deactivated = await deployment(s);
    const first = await createInvoice(s);
    await prisma.deployment.update({
      where: { id: deactivated.id },
      data: { inferenceEnabled: false },
    });
    const { worker } = makeWorker();
    await worker.runOnce();
    expect(await predictionsOf(first.body.invoice.id)).toMatchObject([
      { status: "SKIPPED", lastErrorCode: "DEPLOYMENT_INACTIVE" },
    ]);

    await prisma.deployment.update({
      where: { id: deactivated.id },
      data: { inferenceEnabled: true },
    });
    const second = await createInvoice(s);
    await prisma.deployment.update({
      where: { id: deactivated.id },
      data: { status: "INACTIVE", inferenceEnabled: false },
    });
    await worker.runOnce();
    expect(await predictionsOf(second.body.invoice.id)).toMatchObject([
      { status: "SKIPPED", lastErrorCode: "DEPLOYMENT_INACTIVE" },
    ]);

    await prisma.deployment.update({
      where: { id: deactivated.id },
      data: { status: "ACTIVE", inferenceEnabled: true },
    });
    const third = await createInvoice(s);
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { mlEnabled: false },
    });
    await worker.runOnce();
    expect(await predictionsOf(third.body.invoice.id)).toMatchObject([
      { status: "SKIPPED", lastErrorCode: "ML_DISABLED" },
    ]);
    expect(predictCalls()).toEqual([]);
    // Deactivation never deletes earlier results.
    expect(await prisma.invoicePrediction.count({})).toBeGreaterThan(0);
  });

  it("keeps existing predictions when a deployment is deactivated and skips pending jobs of deleted invoices", async () => {
    const s = await world();
    await deployment(s);
    const done = await createInvoice(s);
    const { worker } = makeWorker();
    await worker.runOnce();

    const doomed = await createInvoice(s);
    const removed = await f.call(
      "delete",
      `/invoices/${doomed.body.invoice.id}?organizationId=${s.org.id}`,
      s.memberCookie,
    );
    expect(removed.status).toBe(204);
    expect(await predictionsOf(doomed.body.invoice.id)).toMatchObject([
      { status: "SKIPPED", lastErrorCode: "INVOICE_DELETED" },
    ]);
    expect(await worker.runOnce()).toBe(0);
    expect(await predictionsOf(done.body.invoice.id)).toMatchObject([
      { status: "SUCCEEDED" },
    ]);
  });

  it("gives each job to exactly one of two concurrent workers (SKIP LOCKED)", async () => {
    const s = await world();
    await deployment(s);
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      ids.push((await createInvoice(s)).body.invoice.id);
    }
    modelApi.predictDelayMs = 40;
    const a = makeWorker({ batchSize: 12, concurrency: 6 });
    const b = makeWorker({ batchSize: 12, concurrency: 6 });
    const [claimedA, claimedB] = await Promise.all([
      a.worker.runOnce(),
      b.worker.runOnce(),
    ]);
    expect(claimedA + claimedB).toBe(12);
    expect(predictCalls()).toHaveLength(12);
    const rows = await prisma.invoicePrediction.findMany({
      where: { invoiceId: { in: ids } },
    });
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    }
  });

  it("claims no more than the worker runs at once, so no unstarted job burns an attempt (CR-503)", async () => {
    const s = await world();
    await deployment(s);
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push((await createInvoice(s)).body.invoice.id);
    }
    // batchSize (10) is larger than concurrency (2): each claim stops at 2.
    const a = makeWorker({ batchSize: 10, concurrency: 2 });
    const b = makeWorker({ batchSize: 10, concurrency: 2 });

    const [claimedA, claimedB] = await Promise.all([
      a.worker.runOnce(),
      b.worker.runOnce(),
    ]);

    expect(claimedA).toBe(2);
    expect(claimedB).toBe(2);
    const rows = await prisma.invoicePrediction.findMany({
      where: { invoiceId: { in: ids } },
    });
    const done = rows.filter((row) => row.status === "SUCCEEDED");
    const waiting = rows.filter((row) => row.status === "PENDING");
    expect(done).toHaveLength(4);
    expect(done.every((row) => row.attempts === 1)).toBe(true);
    // The two jobs nobody claimed were never leased and consumed nothing.
    expect(waiting).toHaveLength(2);
    expect(waiting.every((row) => row.attempts === 0)).toBe(true);
    expect(predictCalls()).toHaveLength(4);

    expect(await a.worker.runOnce()).toBe(2);
    expect(predictCalls()).toHaveLength(6);
    expect(
      (
        await prisma.invoicePrediction.findMany({
          where: { invoiceId: { in: ids } },
        })
      ).every((row) => row.status === "SUCCEEDED" && row.attempts === 1),
    ).toBe(true);
  });

  it("closes a job whose worker died after the last attempt, and re-leases others", async () => {
    const s = await world();
    const d = await deployment(s);
    const created = await createInvoice(s);
    const [job] = await predictionsOf(created.body.invoice.id);
    // A claimed job whose worker died: leased, attempts used up.
    await prisma.invoicePrediction.update({
      where: { id: job!.id },
      data: { attempts: 3, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const { worker } = makeWorker();
    expect(await worker.runOnce()).toBe(0);
    expect((await predictionsOf(created.body.invoice.id))[0]).toMatchObject({
      status: "FAILED",
      lastErrorCode: "ATTEMPTS_EXHAUSTED",
    });
    expect(d.id).toBeTruthy();
  });

  it("polls in the background until stopped, finishing what it started", async () => {
    const s = await world();
    await deployment(s);
    const { worker } = makeWorker();
    worker.start();
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    await waitFor(
      async () => (await predictionsOf(id))[0]?.status === "SUCCEEDED",
      "the background worker to finish the job",
    );
    await worker.stop();
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "SUCCEEDED",
    });
    // stop() resolves only once the loop has ended, so nothing polls any more:
    // a later job stays pending, and the Model API sees no further call.
    const calls = predictCalls().length;
    const later = await createInvoice(s);
    expect(await predictionsOf(later.body.invoice.id)).toMatchObject([
      { status: "PENDING" },
    ]);
    expect(predictCalls()).toHaveLength(calls);
  });
});

describe("MLOPS-06 Model API outages (CR-501)", () => {
  it("waits out a three-minute outage without consuming attempts, then completes", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    // Every poll is an unavailability answer (502): the worker's clock is a
    // fake one that moves 10 s per tick, so three minutes pass instantly.
    modelApi.down = true;
    const { worker, advance } = makeWorker({
      maxAttempts: 3,
      retryBaseMs: 5_000,
      retryMaxMs: 900_000,
    });
    for (let elapsed = 0; elapsed < 180_000; elapsed += 10_000) {
      await worker.runOnce();
      advance(10_000);
    }
    let [row] = await predictionsOf(id);
    // Old behavior: three attempts used up (about 75 s) and FAILED.
    expect(row).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastErrorCode: "MODEL_API_UNAVAILABLE",
    });
    expect(row!.unavailableRetries).toBeGreaterThanOrEqual(4);
    // The backoff never exceeds the cap.
    expect(row!.nextAttemptAt.getTime() - Date.now()).toBeLessThan(
      900_000 + 180_000 + 60_000,
    );

    modelApi.down = false;
    advance(900_000);
    expect(await worker.runOnce()).toBe(1);
    [row] = await predictionsOf(id);
    expect(row).toMatchObject({
      status: "SUCCEEDED",
      attempts: 1,
      probability: 0.37,
    });
  });

  it("fails a job only once it is older than the maximum job age", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    modelApi.down = true;
    const hour = 3_600_000;
    const { worker, advance } = makeWorker({ maxJobAgeMs: 24 * hour });

    // Day one: 23 hours of outage, still waiting.
    for (let tick = 0; tick < 23; tick += 1) {
      await worker.runOnce();
      advance(hour);
    }
    let [row] = await predictionsOf(id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 0 });

    // Past the limit the next unavailability closes it.
    advance(2 * hour);
    expect(await worker.runOnce()).toBe(0);
    [row] = await predictionsOf(id);
    expect(row).toMatchObject({
      status: "FAILED",
      lastErrorCode: "JOB_EXPIRED",
    });
    // Nothing was called for an expired job once closed by the sweep.
    const calls = predictCalls().length;
    advance(hour);
    await worker.runOnce();
    expect(predictCalls()).toHaveLength(calls);
  });

  it("closes a job that turns older than the limit while its call is in flight", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    modelApi.predictMode = "unavailable";
    const { worker, advance } = makeWorker({ maxJobAgeMs: 60_000 });
    // The call is held open; the worker's clock passes the limit meanwhile.
    let release!: () => void;
    modelApi.predictGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = worker.runOnce();
    await waitFor(
      () => predictCalls().length === 1,
      "the predict call to start",
    );
    advance(120_000);
    release();
    expect(await run).toBe(1);
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "FAILED",
      lastErrorCode: "JOB_EXPIRED",
    });
  });

  it("still consumes an attempt per retry for a plain service error (500)", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    modelApi.predictMode = "error";
    const { worker, advance } = makeWorker({ maxAttempts: 3 });
    for (let index = 0; index < 3; index += 1) {
      await worker.runOnce();
      advance();
    }
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "FAILED",
      attempts: 3,
      unavailableRetries: 0,
      lastErrorCode: "MODEL_API_ERROR",
    });
  });
});

describe("MLOPS-06 queue observability (CR-504, CR-526)", () => {
  it("moves the gauge by exact deltas and keeps FAILED rows outside the window out", async () => {
    const s = await world();
    await deployment(s);
    const WINDOW_MS = 900_000;
    // One fixed clock for every read: the other suites share the database, so
    // the gauge is compared before and after, never against absolutes.
    const clock = () => ({ now: new Date(), failedWindowMs: WINDOW_MS });
    const { now } = clock();
    const at = (msAgo: number) => new Date(now.getTime() - msAgo);
    const measure = () =>
      readPredictionQueueMetrics(prisma, {
        now,
        failedWindowMs: WINDOW_MS,
      });

    const before = await measure();

    // Five invoices, each with one PENDING job (createdAt/updatedAt = real now,
    // so never older than the fixed clock by more than the test's runtime).
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await createInvoice(s)).body.invoice.id as string);
    }
    const [pending, recent, edge, old, ancient] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    await prisma.invoicePrediction.updateMany({
      where: { invoiceId: pending },
      data: { createdAt: at(600_000) },
    });
    const failedAt = async (invoiceId: string, msAgo: number) =>
      prisma.invoicePrediction.updateMany({
        where: { invoiceId },
        data: {
          status: "FAILED",
          lastErrorCode: "JOB_EXPIRED",
          updatedAt: at(msAgo),
        },
      });
    await failedAt(recent, 60_000); // inside the window
    await failedAt(edge, WINDOW_MS - 1_000); // inside, 1 s before the edge
    await failedAt(old, 3_600_000); // FAILED one hour ago: outside
    await failedAt(ancient, WINDOW_MS + 1_000); // just outside

    const after = await measure();

    // 5 new PENDING jobs, 4 of them turned FAILED: one stays PENDING.
    expect(after.pendingCount - before.pendingCount).toBe(1);
    // Only the two FAILED rows inside the 15-minute window count; the one
    // from an hour ago and the one 1 s past the edge do not.
    expect(after.failedInWindow - before.failedInWindow).toBe(2);
    // The aged PENDING job is exactly 600 s old at the fixed clock; an older
    // pre-existing job (shared database) would keep the larger value.
    expect(after.oldestPendingAgeSeconds).toBe(
      Math.max(before.oldestPendingAgeSeconds ?? 0, 600),
    );

    // The FAILED-an-hour-ago row alone appears in a 2-hour window.
    const wide = await readPredictionQueueMetrics(prisma, {
      now,
      failedWindowMs: 2 * 3_600_000,
    });
    expect(wide.failedInWindow - after.failedInWindow).toBeGreaterThanOrEqual(
      2,
    );
    // Fake-clock tests of this suite leave rows stamped days ahead: look far past them.
    const stale = await readPredictionQueueMetrics(prisma, {
      now: new Date(Date.now() + 30 * 86_400_000),
      failedWindowMs: WINDOW_MS,
    });
    expect(stale.failedInWindow).toBe(0);
  });
});

describe("MLOPS-06 prior invoices sent to the Model API", () => {
  it("sends only earlier, non-deleted invoices of the same normalized supplier in the same scope", async () => {
    const s = await world();
    await deployment(s);
    const other = await f.makeOrg("other");
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    await seedInvoice(s, { supplierName: "acme ltda", createdAt: at(5) });
    await seedInvoice(s, {
      supplierName: "ACME   Ltda",
      createdAt: at(4),
      businessStatus: "REJECTED",
    });
    // Excluded: other supplier, deleted, other group, other organization.
    await seedInvoice(s, { supplierName: "Acme SA", createdAt: at(3) });
    await seedInvoice(s, {
      supplierName: "ACME LTDA",
      createdAt: at(3),
      deletedAt: at(1),
    });
    await seedInvoice(s, {
      supplierName: "ACME LTDA",
      createdAt: at(3),
      groupId: s.group.id,
    });
    await seedInvoice(s, {
      supplierName: "ACME LTDA",
      createdAt: at(3),
      organizationId: other.id,
    });

    const created = await createInvoice(s, { supplierName: "Acme\tLtda" });
    // Excluded: created after the invoice.
    await seedInvoice(s, {
      supplierName: "acme ltda",
      createdAt: new Date(Date.now() + 86_400_000),
    });
    const { worker } = makeWorker();
    await worker.runOnce();

    const sent = predictCalls()[0]!.body as {
      priorInvoices: Array<{ supplierName: string; businessStatus: string }>;
    };
    expect(sent.priorInvoices.map((prior) => prior.supplierName)).toEqual([
      "ACME   Ltda",
      "acme ltda",
    ]);
    expect(sent.priorInvoices[0]!.businessStatus).toBe("REJECTED");
    expect((await predictionsOf(created.body.invoice.id))[0]!.status).toBe(
      "SUCCEEDED",
    );
  });

  it("includes priors that still have no supplierKey by computing it on the fly (CR-515)", async () => {
    const s = await world();
    await deployment(s);
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    const keyed = await seedInvoice(s, {
      supplierName: "acme ltda",
      createdAt: at(5),
    });
    // Written by an older release during a rolling deploy: no key yet.
    const unkeyed = await seedInvoice(s, {
      supplierName: "ACME\u00a0 Ltda",
      createdAt: at(4),
      businessStatus: "REJECTED",
    });
    const otherSupplier = await seedInvoice(s, {
      supplierName: "Acme SA",
      createdAt: at(3),
    });
    await prisma.invoice.updateMany({
      where: { id: { in: [unkeyed.id, otherSupplier.id] } },
      data: { supplierKey: null },
    });
    // Excluded even without a key: another scope.
    const otherScope = await seedInvoice(s, {
      supplierName: "ACME LTDA",
      createdAt: at(3),
      groupId: s.group.id,
    });
    await prisma.invoice.update({
      where: { id: otherScope.id },
      data: { supplierKey: null },
    });

    const created = await createInvoice(s, { supplierName: "Acme Ltda" });
    const { worker } = makeWorker();
    await worker.runOnce();

    const sent = predictCalls()[0]!.body as {
      priorInvoices: Array<{ supplierName: string; businessStatus: string }>;
    };
    // Newest first: the unkeyed one (computed key matches) then the keyed one.
    expect(sent.priorInvoices.map((prior) => prior.supplierName)).toEqual([
      unkeyed.supplierName,
      keyed.supplierName,
    ]);
    expect(sent.priorInvoices[0]!.businessStatus).toBe("REJECTED");
    expect((await predictionsOf(created.body.invoice.id))[0]!.status).toBe(
      "SUCCEEDED",
    );
    // The database was not touched to do it: the key is still NULL.
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: unkeyed.id } }))
        .supplierKey,
    ).toBeNull();
  });

  it("caps the history at the most recent invoices", async () => {
    const s = await world();
    await deployment(s);
    const base = Date.now() - 400 * 86_400_000;
    await prisma.invoice.createMany({
      data: Array.from({ length: MAX_PRIOR_INVOICES + 5 }, (_, index) => ({
        organizationId: s.org.id,
        groupId: null,
        scopeKey: "organization",
        businessId: `BULK-${randomUUID()}`,
        supplierName: "Gran Proveedor",
        supplierKey: supplierKey("Gran Proveedor"),
        amountPesos: 100 + index,
        currency: "CLP" as const,
        issuedOn: new Date("2026-01-01T00:00:00Z"),
        dueOn: new Date("2026-02-01T00:00:00Z"),
        businessStatus: "APPROVED" as const,
        createdByUserId: s.member.id,
        createdAt: new Date(base + index * 60_000),
      })),
    });
    await createInvoice(s, { supplierName: "Gran Proveedor" });
    const { worker } = makeWorker();
    await worker.runOnce();
    const sent = predictCalls()[0]!.body as {
      priorInvoices: Array<{ amountPesos: number }>;
    };
    expect(sent.priorInvoices).toHaveLength(MAX_PRIOR_INVOICES);
    // The five oldest were dropped.
    expect(Math.min(...sent.priorInvoices.map((p) => p.amountPesos))).toBe(105);
  });
});

describe("MLOPS-06 reading predictions", () => {
  it("shows a reader of the group invoice both the group and the organization prediction with their scope", async () => {
    const s = await world();
    const orgDeployment = await deployment(s);
    const groupDeployment = await deployment(s, { group: true });
    const created = await createInvoice(s, {}, true);
    const id = created.body.invoice.id as string;
    const { worker } = makeWorker();
    await worker.runOnce();
    const path = `/invoices/${id}?organizationId=${s.org.id}`;

    const reader = await f.call("get", path, s.memberCookie);
    expect(reader.status).toBe(200);
    const byDeployment = new Map<
      string,
      { deploymentScope: string; status: string }
    >(
      reader.body.predictions.map(
        (p: {
          deploymentId: string;
          deploymentScope: string;
          status: string;
        }) => [p.deploymentId, p],
      ),
    );
    expect(byDeployment.get(orgDeployment.id)).toMatchObject({
      deploymentScope: "ORGANIZATION",
      status: "SUCCEEDED",
    });
    expect(byDeployment.get(groupDeployment.id)).toMatchObject({
      deploymentScope: "GROUP",
      status: "SUCCEEDED",
    });

    const outsider = await f.call("get", path, s.outsiderCookie);
    expect(outsider.status).toBe(404);
    expect(JSON.stringify(outsider.body)).not.toContain("probability");
  });

  it("applies the invoice read authorization and hides predictions while ML is off", async () => {
    const s = await world();
    await deployment(s, { group: true });
    const created = await createInvoice(s, {}, true);
    const id = created.body.invoice.id as string;
    const { worker } = makeWorker();
    await worker.runOnce();
    const path = `/invoices/${id}?organizationId=${s.org.id}`;

    const reader = await f.call("get", path, s.memberCookie);
    expect(reader.status).toBe(200);
    expect(reader.body.predictions).toHaveLength(1);

    // An outsider (not a member) gets the same 404 as without predictions.
    const outsider = await f.call("get", path, s.outsiderCookie);
    expect(outsider.status).toBe(404);
    expect(JSON.stringify(outsider.body)).not.toContain("probability");

    // A member without readInvoices is refused.
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: false },
    });
    await prisma.groupMembership.deleteMany({
      where: { userId: s.member.id },
    });
    const denied = await f.call("get", path, s.memberCookie);
    expect([403, 404]).toContain(denied.status);
    expect(JSON.stringify(denied.body)).not.toContain("probability");

    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: true },
    });
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { mlEnabled: false },
    });
    const off = await f.call("get", path, s.memberCookie);
    expect(off.status).toBe(200);
    expect(off.body).not.toHaveProperty("predictions");
  });
});

describe("MLOPS-06 supplier key parity with the Python contract", () => {
  it("matches priors by NFKC + lowercase + explicit whitespace, like invoiceops_ml", async () => {
    const s = await world();
    await deployment(s);
    const at = (days: number) => new Date(Date.now() - days * 86_400_000);
    // Included: NBSP, \x1c, U+0085, ligature and fullwidth variants of one key.
    await seedInvoice(s, { supplierName: "ACME  Ltda", createdAt: at(6) });
    await seedInvoice(s, { supplierName: "acme\x1cltda", createdAt: at(5) });
    await seedInvoice(s, { supplierName: "Acme\u0085LTDA", createdAt: at(4) });
    await seedInvoice(s, { supplierName: "ＡＣＭＥ Ltda", createdAt: at(3) });
    // Excluded: a different key (ß is not folded to ss; the old SQL differed).
    await seedInvoice(s, { supplierName: "Acme Ltd", createdAt: at(2) });
    await seedInvoice(s, { supplierName: "Straße", createdAt: at(2) });
    await createInvoice(s, { supplierName: "Strasse", createdAt: at(1) });
    await createInvoice(s, { supplierName: "  acme   ltda " });
    const { worker } = makeWorker();
    await worker.runOnce();
    const sent = predictCalls()
      .map(
        (call) =>
          call.body as {
            invoice: { supplierName: string };
            priorInvoices: unknown[];
          },
      )
      .find((body) => body.invoice.supplierName.includes("acme"));
    expect(sent?.priorInvoices).toHaveLength(4);
  });
});

describe("MLOPS-06 graceful shutdown", () => {
  it("aborts the in-flight Model API call and releases the claim without consuming the attempt", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;
    // The Model API holds the call open and never answers: stop() can only
    // finish because it aborts the in-flight call (otherwise this test hangs
    // until its timeout instead of asserting a duration).
    let answer!: () => void;
    modelApi.predictGate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { worker } = makeWorker();
    worker.start();
    await waitFor(
      () => predictCalls().length === 1,
      "the predict call to start",
    );
    await worker.stop();
    answer();
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lastErrorCode: null,
    });
  });
});

describe("MLOPS-06 slow first worker", () => {
  it("cannot overwrite the result of the worker that re-claimed after the lease", async () => {
    const s = await world();
    await deployment(s);
    const created = await createInvoice(s);
    const id = created.body.invoice.id as string;

    // Worker A claims (attempt 1) and hangs in the Model API: its predict call
    // carries probability 0.11 and is held open by a gate.
    modelApi.probability = 0.11;
    let release!: () => void;
    modelApi.predictGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = makeWorker();
    const aRun = a.worker.runOnce();
    await waitFor(
      () => predictCalls().length === 1,
      "worker A to call the Model API",
    );
    // The lease expires (B's clock is past A's 5 minute lease, no sleeping);
    // worker B re-claims (attempt 2) and settles first.
    modelApi.probability = 0.9;
    const b = makeWorker();
    b.advance(10 * 60_000);
    expect(await b.worker.runOnce()).toBe(1);
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "SUCCEEDED",
      probability: 0.9,
      attempts: 2,
    });

    release();
    // A's late result (0.11, attempt 1) is a no-op.
    expect(await aRun).toBe(1);
    expect((await predictionsOf(id))[0]).toMatchObject({
      status: "SUCCEEDED",
      probability: 0.9,
      attempts: 2,
    });
  });
});

describe("MLOPS-06 supplier key backfill", () => {
  it("fills missing keys with the canonical key, only those, and is idempotent", async () => {
    const s = await world();
    const missing = await seedInvoice(s, {
      supplierName: "ACME\u00a0 Straße",
      createdAt: new Date(Date.now() - 86_400_000),
    });
    await prisma.invoice.update({
      where: { id: missing.id },
      data: { supplierKey: null },
    });
    const kept = await seedInvoice(s, {
      supplierName: "Keep Me",
      createdAt: new Date(Date.now() - 86_400_000),
    });
    expect(
      await backfillSupplierKeys(prisma, { batchSize: 1 }),
    ).toBeGreaterThan(0);
    const rows = await prisma.invoice.findMany({
      where: { id: { in: [missing.id, kept.id] } },
      select: { id: true, supplierKey: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.supplierKey]))).toEqual({
      [missing.id]: "acme straße",
      [kept.id]: "keep me",
    });
    expect(await backfillSupplierKeys(prisma)).toBe(0);
  });
});

describe("MLOPS-06 invoice creation does not conflict with ML changes (CR-505)", () => {
  it("reads no Deployment row inside the invoice transaction and only inserts the jobs there", async () => {
    const s = await world();
    const d = await deployment(s);
    const logged = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
      log: [{ emit: "event", level: "query" }],
    });
    const queries: string[] = [];
    logged.$on("query", (event) => queries.push(event.query));
    try {
      const result = await createInvoiceCreateService(logged).createInvoice(
        s.member.id,
        InvoiceCreateRequestSchema.parse({
          organizationId: s.org.id,
          businessId: `FAC-${randomUUID()}`,
          supplierName: "Proveedor local",
          amountPesos: 12500,
          currency: "CLP",
          issuedOn: "2026-10-25",
          dueOn: "2026-11-25",
          businessStatus: "PENDING",
        }),
        `key-${randomUUID()}`,
        null,
      );
      expect(result.replayed).toBe(false);
      expect(
        (await predictionsOf(result.invoice.id)).map((row) => row.deploymentId),
      ).toEqual([d.id]);
    } finally {
      await logged.$disconnect();
    }

    const reads = (list: string[]) =>
      list.filter((query) => /(FROM|JOIN)[^;]*"Deployment"/.test(query));
    // Prisma does not log BEGIN/COMMIT, but the order is telling: the unlocked
    // authorization preflight (CR-533) comes first, then the one read of the
    // eligible deployments, then the transaction, whose first statement is
    // the membership lock.
    expect(reads(queries)).toHaveLength(1);
    const readAt = queries.findIndex((query) => reads([query]).length === 1);
    const lockAt = queries.findIndex((query) => /FOR SHARE/.test(query));
    expect(readAt).toBeGreaterThan(0);
    expect(lockAt).toBe(readAt + 1);
    // The preflight takes no lock.
    expect(queries.slice(0, readAt).some((query) => /FOR /.test(query))).toBe(
      false,
    );
    // Inside the transaction: no read of Deployment (it would take predicate
    // locks that conflict with concurrent deployment changes), and the jobs go
    // in as a plain INSERT.
    const inside = queries.slice(lockAt);
    expect(inside[0]).toMatch(/FOR SHARE/);
    expect(reads(inside)).toEqual([]);
    expect(
      inside.some((query) =>
        /INSERT INTO [^ ]*"InvoicePrediction"/.test(query),
      ),
    ).toBe(true);
  });

  it("keeps creating while inference and mlEnabled are toggled, without RETRYABLE_CONFLICT", async () => {
    const s = await world();
    const d = await deployment(s);
    let stop = false;
    // A toggler flips the deployment and the organization switch in a tight
    // loop for the whole time the invoices are created.
    const toggler = (async () => {
      let on = false;
      while (!stop) {
        on = !on;
        await prisma.deployment.update({
          where: { id: d.id },
          data: { inferenceEnabled: !on },
        });
        await prisma.organization.update({
          where: { id: s.org.id },
          data: { mlEnabled: !on },
        });
      }
    })();
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      created.push(await createInvoice(s));
    }
    stop = true;
    await toggler;

    expect(created.map((response) => response.status)).toEqual(
      Array(12).fill(201),
    );
    // Whatever instant each create saw, every job is well-formed.
    const jobs = await prisma.invoicePrediction.findMany({
      where: { invoiceId: { in: created.map((r) => r.body.invoice.id) } },
    });
    expect(jobs.length).toBeLessThanOrEqual(12);
    for (const job of jobs) {
      expect(job).toMatchObject({
        deploymentId: d.id,
        organizationId: s.org.id,
        scopeKey: "organization",
        status: "PENDING",
        attempts: 0,
      });
    }
  });
});
