import { PrismaPg } from "@prisma/adapter-pg";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PrismaClient,
  type EvidenceRecord,
  type EvidenceBatch,
} from "../src/generated/prisma/client.js";
import { createApp } from "../src/app.js";
import { createAuthService } from "../src/auth.js";
import { createEvidenceReadService } from "../src/evidence-read.js";
import {
  buildEvidenceV2Payload,
  canonicalizeEvidenceV2,
  hashEvidenceV2Bytes,
  verifyEvidenceProofV2,
} from "../src/evidence.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";
import type { ResourceContext } from "../src/resources.js";

const url = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
  log: [{ emit: "event", level: "query" }],
});
const queries: string[] = [];
prisma.$on("query", (event) => queries.push(event.query));
afterAll(async () => {
  await prisma.$disconnect();
});

async function fixture() {
  const user = await prisma.user.create({
    data: {
      name: "Private actor",
      rut: randomUUID(),
      email: "private@example.test",
    },
  });
  const other = await prisma.user.create({
    data: { name: "Other actor", rut: randomUUID() },
  });
  const organization = await prisma.organization.create({
    data: { name: "Read test", slug: randomUUID() },
  });
  const foreign = await prisma.organization.create({
    data: { name: "Foreign read test", slug: randomUUID() },
  });
  for (const organizationId of [organization.id, foreign.id])
    await prisma.organizationMembership.create({
      data: { userId: user.id, organizationId, role: "STUDENT" },
    });
  await prisma.organizationMembership.create({
    data: {
      userId: other.id,
      organizationId: organization.id,
      role: "STUDENT",
    },
  });
  const group = await prisma.group.create({
    data: { organizationId: organization.id, name: "Read group" },
  });
  await prisma.groupMembership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      groupId: group.id,
    },
  });
  const context: ResourceContext = {
    organizationId: organization.id,
    ownerType: "user",
    ownerId: user.id,
  };
  const groupContext: ResourceContext = {
    ...context,
    ownerType: "group",
    ownerId: group.id,
  };
  const token = randomUUID();
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("base64"),
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  const app = createApp(
    { isReady: async () => true },
    createAuthService(prisma),
    { evidenceRead: createEvidenceReadService(prisma) },
  );
  async function record(
    scope = context,
    corrupt = false,
    createdAt = new Date("2026-10-21T01:00:00.123Z"),
  ) {
    const invoice = await prisma.invoice.create({
      data: {
        invoiceId: randomUUID(),
        organizationId: scope.organizationId,
        ownerType: scope.ownerType === "user" ? "USER" : "GROUP",
        ownerId: scope.ownerId,
        createdByUserId: user.id,
        vendorName: "Private vendor",
        invoiceAmountCents: 1,
        hasPurchaseOrder: true,
        threeWayMatch: true,
        vendorTenureDays: 1,
        previousIncidents12m: 0,
        bankAccountRecentlyChanged: false,
        amountVsVendorMedian: 1,
        countryRisk: "low",
      },
    });
    const event = await prisma.decisionEvent.create({
      data: {
        invoiceId: invoice.id,
        decision: "AUTO_PROCESS",
        mode: "RULE_V1",
        ruleVersion: "invoice-rules-v1",
        actorUserId: user.id,
        actorName: user.name,
        actorRut: user.rut,
        correlationId: randomUUID(),
        createdAt,
      },
    });
    const canonicalPayload = Buffer.from(
      canonicalizeEvidenceV2(
        buildEvidenceV2Payload({
          event: {
            ...event,
            manualReviewThreshold: null,
            policyProbability: null,
          },
          context: scope,
        }),
      ),
    );
    return prisma.evidenceRecord.create({
      data: {
        decisionEventId: event.id,
        invoiceRecordId: invoice.id,
        organizationId: scope.organizationId,
        ownerType: scope.ownerType === "user" ? "USER" : "GROUP",
        ownerId: scope.ownerId,
        evidenceVersion: "invoice-evidence-v2",
        canonicalVersion: "invoice-evidence-canonical-v2",
        canonicalPayload,
        leafHash: corrupt
          ? Buffer.alloc(32)
          : Buffer.from(hashEvidenceV2Bytes(canonicalPayload).slice(2), "hex"),
        createdAt,
      },
    });
  }
  async function batch(
    row: Awaited<ReturnType<typeof record>>,
    corrupt = false,
  ) {
    const owner = {
      organizationId: row.organizationId,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
    };
    const batch = await prisma.evidenceBatch.create({
      data: {
        ...owner,
        rootHash: corrupt ? Buffer.alloc(32, 99) : row.leafHash,
        leafCount: 1,
        policyVersion: "invoice-merkle-v2",
        createdAt: new Date("2026-10-21T02:00:00.123Z"),
      },
    });
    await prisma.evidenceBatchItem.create({
      data: {
        ...owner,
        batchId: batch.id,
        evidenceRecordId: row.id,
        leafIndex: 0,
      },
    });
    return batch;
  }
  const get = (
    path: string,
    scope = context,
    extra: Record<string, string> = {},
  ) =>
    request(app)
      .get(`${path}?${new URLSearchParams({ ...scope, ...extra })}`)
      .set("Cookie", `invoiceops_session=${token}`);
  return {
    user,
    other,
    context,
    groupContext,
    foreign,
    record,
    batch,
    get,
    session,
  };
}

describe("APP12 S6 isolated PostgreSQL contextual HTTP", () => {
  describe("tied timestamps and scoped pagination", () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    const records: EvidenceRecord[] = [];
    const batches: EvidenceBatch[] = [];
    let groupRecord: EvidenceRecord;
    beforeAll(async () => {
      f = await fixture();
      for (let index = 0; index < 5; index++) {
        const row = await f.record();
        records.push(row);
        batches.push(await f.batch(row));
      }
      groupRecord = await f.record(f.groupContext);
      const foreignRecord = await f.record({
        ...f.context,
        organizationId: f.foreign.id,
      });
      await f.batch(groupRecord);
      await f.batch(foreignRecord);
    });
    it.each(["records", "batches"] as const)(
      "paginates %s exactly once and rejects foreign or context-mismatched cursors",
      async (kind) => {
        const expected = kind === "records" ? records : batches;
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const response = await f.get(`/evidence-${kind}`, f.context, {
            limit: "2",
            ...(cursor ? { cursor } : {}),
          });
          expect(response.status).toBe(200);
          expect(response.body.items.length).toBeLessThanOrEqual(2);
          seen.push(
            ...response.body.items.map((item: { id: string }) => item.id),
          );
          cursor = response.body.nextCursor ?? undefined;
        } while (cursor);
        expect(seen).toEqual(
          expected
            .map((row) => row.id)
            .sort()
            .reverse(),
        );
        expect(new Set(seen).size).toBe(5);
        const first = await f.get(`/evidence-${kind}`, f.context, {
          limit: "1",
        });
        const foreignCursor = Buffer.from(
          JSON.stringify([
            1,
            f.context.organizationId,
            "user",
            f.context.ownerId,
            kind,
            null,
            groupRecord.id,
          ]),
        ).toString("base64url");
        expect(
          (
            await f.get(`/evidence-${kind}`, f.context, {
              cursor: foreignCursor,
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await f.get(`/evidence-${kind}`, f.groupContext, {
              cursor: first.body.nextCursor,
            })
          ).status,
        ).toBe(400);
      },
    );
    it("filters batch membership without fetching proofs", async () => {
      const filtered = await f.get("/evidence-batches", f.context, {
        recordId: records[0].id,
      });
      expect(filtered.body.items.map((row: { id: string }) => row.id)).toEqual([
        batches[0].id,
      ]);
    });
    it("continues strictly after the cursor when newer evidence is appended", async () => {
      const first = await f.get("/evidence-records", f.context, { limit: "2" });
      const added = await f.record(
        f.context,
        false,
        new Date("2026-10-21T03:00:00Z"),
      );
      const next = await f.get("/evidence-records", f.context, {
        limit: "100",
        cursor: first.body.nextCursor,
      });
      expect(next.status).toBe(200);
      expect(next.body.items.map((row: { id: string }) => row.id)).toEqual(
        records
          .map((row) => row.id)
          .sort()
          .reverse()
          .slice(2),
      );
      expect(next.text).not.toContain(added.id);
    });
  });
  it("reads genuine native proofs and redacted DTOs using only SELECT operations after fixture setup", async () => {
    const f = await fixture();
    const row = await f.record();
    const batch = await f.batch(row);
    queries.length = 0;
    for (const path of [
      "/evidence-records",
      "/evidence-batches",
      `/evidence-records/${row.id}`,
      `/evidence-batches/${batch.id}`,
      `/evidence-batches/${batch.id}/proofs/${row.id}`,
    ]) {
      const response = await f.get(path);
      expect(response.status).toBe(200);
      expect(response.text).not.toMatch(
        /canonicalPayload|Private|private@example|actorRut|actorName|tokenHash|signer|reservation/,
      );
      if ("proof" in response.body)
        expect(verifyEvidenceProofV2(response.body.proof)).toBe(true);
    }
    expect(queries.length).toBeGreaterThan(5);
    expect(queries.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
  });
  it("isolates cross-user/group/org objects and enforces live revocations and session expiry", async () => {
    const f = await fixture();
    const row = await f.record();
    const batch = await f.batch(row);
    const otherRow = await f.record({ ...f.context, ownerId: f.other.id });
    const groupRow = await f.record(f.groupContext);
    const groupBatch = await f.batch(groupRow);
    const foreignRow = await f.record({
      ...f.context,
      organizationId: f.foreign.id,
    });
    const foreignBatch = await f.batch(foreignRow);
    for (const id of [otherRow.id, groupRow.id, foreignRow.id, randomUUID()])
      expect((await f.get(`/evidence-records/${id}`)).status).toBe(404);
    for (const id of [groupBatch.id, foreignBatch.id, randomUUID()])
      expect((await f.get(`/evidence-batches/${id}`)).status).toBe(404);
    expect(
      (await f.get(`/evidence-batches/${batch.id}/proofs/${groupRow.id}`))
        .status,
    ).toBe(404);
    expect(
      (await f.get("/evidence-records", { ...f.context, ownerId: f.other.id }))
        .status,
    ).toBe(403);
    await prisma.groupMembership.deleteMany({
      where: { groupId: f.groupContext.ownerId, userId: f.user.id },
    });
    expect(
      (
        await f.get(
          `/evidence-batches/${groupBatch.id}/proofs/${groupRow.id}`,
          f.groupContext,
        )
      ).status,
    ).toBe(403);
    await prisma.organizationMembership.deleteMany({
      where: { userId: f.user.id, organizationId: f.context.organizationId },
    });
    expect((await f.get(`/evidence-records/${row.id}`)).status).toBe(403);
    await prisma.session.update({
      where: { id: f.session.id },
      data: { expiresAt: new Date(0) },
    });
    expect(
      (await f.get(`/evidence-batches/${batch.id}/proofs/${row.id}`)).status,
    ).toBe(401);
  });
  it("rejects persisted invalid preimages/hashes and roots without fake verified or empty results", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const bad = await f.record(f.context, true);
      const good = await f.record();
      const badRecordBatch = await f.batch(bad);
      const badRootBatch = await f.batch(good, true);
      for (const path of [
        `/evidence-records/${bad.id}`,
        `/evidence-batches/${badRecordBatch.id}`,
        `/evidence-batches/${badRootBatch.id}`,
        `/evidence-batches/${badRootBatch.id}/proofs/${good.id}`,
      ]) {
        const response = await f.get(path);
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          status: "error",
          code: "INTEGRITY_INVALID",
        });
      }
    } finally {
      log.mockRestore();
    }
  });
});
