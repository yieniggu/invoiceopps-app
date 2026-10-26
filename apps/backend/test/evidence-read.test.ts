import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/auth.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createEvidenceReadService } from "../src/evidence-read.js";
import {
  buildEvidenceV2Payload,
  canonicalizeEvidenceV2,
  hashEvidenceV2Bytes,
  verifyEvidenceProofV2,
} from "../src/evidence.js";

const uid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = {
  organizationId: uid(1),
  ownerType: "user" as const,
  ownerId: uid(2),
};
const query = new URLSearchParams(context).toString();
const cookie = "invoiceops_session=synthetic";
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const permissions = { organization: true, group: true, session: true };
  const event = {
    id: uid(3),
    invoiceId: uid(4),
    correlationId: uid(5),
    createdAt: new Date("2026-10-21T00:00:00Z"),
    decision: "AUTO_PROCESS",
    ruleVersion: "invoice-rules-v1",
    mode: "RULE_V1",
    policyVersion: null,
    manualReviewThreshold: null,
    policyProbability: null,
    policyProbabilitySource: null,
    modelId: null,
    modelVersion: null,
    modelRunId: null,
    recommendation: null,
    actorName: "private-actor",
    actorRut: "private-rut",
    invoice: { id: uid(4), ...context, ownerType: "USER" },
  };
  const bytes = canonicalizeEvidenceV2(
    buildEvidenceV2Payload({ event, context }),
  );
  const leafHash = Buffer.from(hashEvidenceV2Bytes(bytes).slice(2), "hex");
  const record = {
    id: uid(6),
    ...context,
    ownerType: "USER",
    decisionEventId: event.id,
    invoiceRecordId: event.invoiceId,
    createdAt: event.createdAt,
    evidenceVersion: "invoice-evidence-v2",
    canonicalVersion: "invoice-evidence-canonical-v2",
    leafHash,
    canonicalPayload: bytes,
    decisionEvent: event,
    email: "private@example.test",
  };
  const item = {
    batchId: uid(7),
    evidenceRecordId: record.id,
    ...context,
    ownerType: "USER",
    leafIndex: 0,
    evidenceRecord: record,
  };
  const batch = {
    id: uid(7),
    ...context,
    ownerType: "USER",
    createdAt: event.createdAt,
    leafCount: 1,
    rootHash: leafHash,
    policyVersion: "invoice-merkle-v2",
    items: [item],
    rawSignedTransaction: "private-tx",
  };
  const db = {
    session: {
      findUnique: vi.fn(async () =>
        permissions.session
          ? {
              expiresAt: new Date(Date.now() + 100000),
              user: {
                id: context.ownerId,
                name: "private-actor",
                rut: "private-rut",
                email: "private@example.test",
                username: null,
                platformAdministrator: { id: 1 },
                memberships: [],
              },
            }
          : null,
      ),
    },
    organizationMembership: {
      findUnique: vi.fn(async () =>
        permissions.organization ? { userId: context.ownerId } : null,
      ),
    },
    groupMembership: {
      findFirst: vi.fn(async () =>
        permissions.group ? { userId: context.ownerId } : null,
      ),
    },
    evidenceRecord: {
      findMany: vi.fn(async () => [record]),
      findFirst: vi.fn(async () => record as typeof record | null),
    },
    evidenceBatch: {
      findMany: vi.fn(async () => [batch]),
      findFirst: vi.fn(async () => batch as typeof batch | null),
    },
  };
  const prisma = db as unknown as PrismaClient;
  const auth = createAuthService(prisma);
  const app = createApp({ isReady: async () => true }, auth, {
    evidenceRead: createEvidenceReadService(prisma),
  });
  const get = (path: string, params = query) =>
    request(app).get(`${path}?${params}`).set("Cookie", cookie);
  return { permissions, db, record, batch, app, get, auth };
}

describe("APP12 S6 read HTTP surface", () => {
  it("authenticates the registered evidence namespace before query parsing", async () => {
    const app = createApp({ isReady: async () => true });
    for (const path of ["/evidence-records", "/evidence-batches"]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        status: "error",
        message: "Unauthorized",
      });
    }
  });
  it("uses the native session lookup, returns bounded allowlisted metadata without rebuilding per row", async () => {
    const f = fixture();
    for (const kind of ["records", "batches"]) {
      const result = await f.get(`/evidence-${kind}`);
      expect(result.status).toBe(200);
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.body.items).toHaveLength(1);
      expect(result.body.items[0].integrity).toBe("not-checked");
      expect(result.body.nextCursor).toBeNull();
      expect(result.text).not.toMatch(
        /canonicalPayload|decisionEvent"|actor|private|email|rawSigned|reservation|tokenHash/,
      );
    }
    expect(f.db.evidenceBatch.findFirst).not.toHaveBeenCalled();
    expect(f.db.evidenceRecord.findFirst).not.toHaveBeenCalled();
    expect(f.db.evidenceRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: context.organizationId,
          ownerType: "USER",
          ownerId: context.ownerId,
        },
        take: 51,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: expect.not.objectContaining({ canonicalPayload: true }),
      }),
    );
    expect(f.db.session.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: expect.not.stringContaining("synthetic") },
      }),
    );
  });
  it("validates encoded IDs and handles HEAD as the ordinary read-only GET transport", async () => {
    const f = fixture();
    for (const value of ["invalid", "a%2Fb", "%E0%A4%A"])
      expect((await f.get(`/evidence-records/${value}`)).status).toBe(400);
    const head = await request(f.app)
      .head(`/evidence-records?${query}&limit=100`)
      .set("Cookie", cookie);
    expect(head.status).toBe(200);
    expect(head.text).toBeUndefined();
    expect(f.db.evidenceRecord.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 101 }),
    );
  });
  it("derives a native proof and verifies records/batches, never serializing internal source objects", async () => {
    const f = fixture();
    for (const path of [
      `/evidence-records/${f.record.id}`,
      `/evidence-batches/${f.batch.id}`,
      `/evidence-batches/${f.batch.id}/proofs/${f.record.id}`,
    ]) {
      const response = await f.get(path);
      expect(response.status).toBe(200);
      expect(response.text).not.toMatch(
        /canonicalPayload|actor|private|email|rawSigned|reservation|tokenHash/,
      );
      expect(Object.values(response.body)[0]).toMatchObject({
        integrity: "server-verified",
      });
      if ("proof" in response.body)
        expect(verifyEvidenceProofV2(response.body.proof)).toBe(true);
    }
    const detail = await f.get(`/evidence-records/${f.record.id}`);
    expect(Object.keys(detail.body.record).sort()).toEqual(
      [
        "id",
        "decisionEventId",
        "invoiceRecordId",
        "createdAt",
        "evidenceVersion",
        "canonicalVersion",
        "leafHash",
        "integrity",
      ].sort(),
    );
    const batch = await f.get(`/evidence-batches/${f.batch.id}`);
    expect(batch.body.batch.items).toEqual([
      { recordId: f.record.id, leafIndex: 0 },
    ]);
  });
  it.each(["organization", "group", "session"] as const)(
    "rejects revoked %s before querying evidence, including platform administrators",
    async (permission) => {
      const f = fixture();
      f.permissions[permission] = false;
      const params =
        permission === "group"
          ? new URLSearchParams({
              ...context,
              ownerType: "group",
              ownerId: uid(8),
            }).toString()
          : query;
      for (const path of [
        "/evidence-records",
        `/evidence-records/${uid(6)}`,
        "/evidence-batches",
        `/evidence-batches/${uid(7)}`,
        `/evidence-batches/${uid(7)}/proofs/${uid(6)}`,
      ])
        expect((await f.get(path, params)).status).toBe(
          permission === "session" ? 401 : 403,
        );
      expect(f.db.evidenceRecord.findFirst).not.toHaveBeenCalled();
      expect(f.db.evidenceRecord.findMany).not.toHaveBeenCalled();
      expect(f.db.evidenceBatch.findFirst).not.toHaveBeenCalled();
    },
  );
  it("denies another user's SELF context even with current organization membership", async () => {
    const f = fixture();
    expect(
      (
        await f.get(
          "/evidence-records",
          new URLSearchParams({ ...context, ownerId: uid(99) }).toString(),
        )
      ).status,
    ).toBe(403);
    expect(f.db.evidenceRecord.findMany).not.toHaveBeenCalled();
  });
  it.each([
    "limit=0",
    "limit=101",
    "limit=1.1",
    "limit=01",
    "limit=2&limit=3",
    "cursor=",
    "cursor=%25",
    "recordId=bad",
    "userId=forged",
    "organizationId=x",
    "ownerType=USER",
    "ownerId[x]=x",
  ])("validates scalar bounds and rejects query %s", async (suffix) => {
    const f = fixture();
    expect(
      (await f.get("/evidence-records", `${query}&${suffix}`)).status,
    ).toBe(400);
    expect(f.db.evidenceRecord.findMany).not.toHaveBeenCalled();
  });
  it("encodes context/filter-bound cursors and resolves unique-ID boundaries before bounded reads", async () => {
    const f = fixture();
    f.db.evidenceRecord.findMany.mockResolvedValueOnce([
      f.record,
      { ...f.record, id: uid(9) },
    ]);
    const first = await f.get("/evidence-records", `${query}&limit=1`);
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTypeOf("string");
    const next = await f.get(
      "/evidence-records",
      `${query}&limit=1&cursor=${cursor}`,
    );
    expect(next.status).toBe(200);
    expect(f.db.evidenceRecord.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cursor: { id: f.record.id },
        skip: 1,
        take: 2,
      }),
    );
    for (const suffix of [
      `recordId=${uid(9)}`,
      "ownerType=group",
      `organizationId=${uid(9)}`,
    ])
      expect(
        (
          await f.get(
            "/evidence-records",
            `${query}&cursor=${cursor}&${suffix}`,
          )
        ).status,
      ).toBe(400);
    expect(
      (await f.get("/evidence-batches", `${query}&cursor=${cursor}`)).status,
    ).toBe(400);
    f.db.evidenceRecord.findFirst.mockResolvedValueOnce(null);
    expect(
      (await f.get("/evidence-records", `${query}&cursor=${cursor}`)).status,
    ).toBe(400);
  });
  it("returns indistinguishable 404 for scoped missing details and wrong proof membership", async () => {
    const f = fixture();
    f.db.evidenceRecord.findFirst.mockResolvedValueOnce(null);
    const record = await f.get(`/evidence-records/${uid(99)}`);
    f.db.evidenceBatch.findFirst.mockResolvedValueOnce(null);
    const batch = await f.get(`/evidence-batches/${uid(99)}`);
    const member = await f.get(
      `/evidence-batches/${f.batch.id}/proofs/${uid(99)}`,
    );
    expect([record.status, batch.status, member.status]).toEqual([
      404, 404, 404,
    ]);
    expect(record.body).toEqual(batch.body);
    expect(record.body).toEqual(member.body);
    expect(f.db.evidenceRecord.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: uid(99),
          organizationId: context.organizationId,
          ownerType: "USER",
          ownerId: context.ownerId,
        },
      }),
    );
  });
  it.each(["bytes", "hash", "root", "index", "source-context"])(
    "fails closed on native %s tampering with safe error and diagnostics",
    async (tamper) => {
      const f = fixture();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (tamper === "bytes")
        f.record.canonicalPayload = Buffer.from("private-payload");
      if (tamper === "hash") f.record.leafHash = Buffer.alloc(32);
      if (tamper === "root") f.batch.rootHash = Buffer.alloc(32);
      if (tamper === "index") f.batch.items[0].leafIndex = 1;
      if (tamper === "source-context")
        f.record.decisionEvent.invoice.ownerId = uid(99);
      const response = await f.get(
        `/evidence-batches/${f.batch.id}/proofs/${f.record.id}`,
      );
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        status: "error",
        code: "INTEGRITY_INVALID",
      });
      expect(log.mock.calls).toEqual([
        [
          JSON.stringify({
            feature: "evidence-read",
            outcome: "failure",
            code: "INTEGRITY_INVALID",
          }),
        ],
      ]);
      if (
        tamper === "bytes" ||
        tamper === "hash" ||
        tamper === "source-context"
      )
        expect((await f.get(`/evidence-records/${f.record.id}`)).status).toBe(
          409,
        );
    },
  );
  it("maps dependency failures safely, supports optional service 503 and exposes no mutation routes", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    f.db.evidenceRecord.findMany.mockRejectedValueOnce(
      new Error("private SQL provider payload"),
    );
    const failure = await f.get("/evidence-records");
    expect(failure.status).toBe(503);
    expect(failure.body).toEqual({ status: "error", code: "UNAVAILABLE" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
    const unavailable = createApp({ isReady: async () => true }, f.auth);
    expect(
      (
        await request(unavailable)
          .get(`/evidence-records?${query}`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(503);
    for (const method of ["post", "patch", "put", "delete"] as const)
      for (const path of [
        "/evidence-records",
        `/evidence-records/${uid(6)}`,
        "/evidence-batches",
        `/evidence-batches/${uid(7)}/proofs/${uid(6)}`,
      ]) {
        const client = request(f.app);
        expect(
          (
            await client[method](`${path}?${query}`)
              .set("Host", "127.0.0.1")
              .set("Origin", "http://127.0.0.1")
              .set("Cookie", cookie)
          ).status,
        ).toBe(404);
      }
  });
});
