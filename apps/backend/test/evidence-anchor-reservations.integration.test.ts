import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { createInvoiceService } from "../src/invoices.js";
import { createEvidencePersistence } from "../src/evidence-persistence.js";
// The isolated runner applies the reservation migration before this suite.
import { createEvidenceAnchorReservation } from "../src/evidence-anchor-reservation.js";
import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";
import {
  fixtureSigner,
  signedAnchorTransport,
} from "./evidence-anchor-fixture.js";

const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const target = {
  chainId: 31337,
  contractAddress: `0x${"12".repeat(20)}`,
};
const otherContract = `0x${"56".repeat(20)}`;

async function reset() {
  // Only the runner-owned isolated database may be reset. The reservation table
  // must exist from the applied migration; this test never creates it.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "EvidenceAnchorObservation", "EvidencePreparedAnchorTransaction", "EvidenceSignerPreparationSlot", "EvidenceAnchorReservation", "EvidenceBatchItem", "EvidenceBatch", "EvidenceRecord"',
  );
  await prisma.decisionEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  try {
    await reset();
  } finally {
    await prisma.$disconnect();
  }
});

async function fixture() {
  const organization = await prisma.organization.create({
    data: { name: "Reservation organization", slug: "reservation-org" },
  });
  const actor = await prisma.user.create({
    data: { name: "Owner", rut: "123456785" },
  });
  const outsider = await prisma.user.create({
    data: { name: "Outsider", rut: "123456793" },
  });
  await prisma.organizationMembership.create({
    data: {
      userId: actor.id,
      organizationId: organization.id,
      role: "STUDENT",
    },
  });
  const context = {
    organizationId: organization.id,
    ownerType: "user" as const,
    ownerId: actor.id,
  };
  let invoiceNumber = 0;
  async function batch() {
    invoiceNumber += 1;
    const invoice = await prisma.invoice.create({
      data: {
        invoiceId: `RESERVATION-${invoiceNumber}`,
        organizationId: organization.id,
        ownerType: "USER",
        ownerId: actor.id,
        createdByUserId: actor.id,
        vendorName: "Reservation vendor",
        invoiceAmountCents: invoiceNumber,
        hasPurchaseOrder: true,
        threeWayMatch: true,
        vendorTenureDays: 1,
        previousIncidents12m: 0,
        bankAccountRecentlyChanged: false,
        amountVsVendorMedian: 1,
        countryRisk: "low",
      },
    });
    await createInvoiceService(prisma).decideInvoice(
      actor,
      context,
      invoice.invoiceId,
      { mode: "RULE_V1" },
    );
    const evidence = await prisma.evidenceRecord.findFirstOrThrow({
      where: { invoiceRecordId: invoice.id },
    });
    return createEvidencePersistence(prisma).createBatch(actor, context, [
      evidence.id,
    ]);
  }
  return { actor, outsider, context, batch };
}

describe("APP-11 PostgreSQL reservation contract", () => {
  it("AC-DR03 elects one winner across two independent Prisma connections", async () => {
    const { actor, context, batch } = await fixture();
    const evidenceBatch = await batch();
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      const [a, b] = await Promise.all([
        createEvidenceAnchorReservation(prisma).claimAnchorSubmission(
          actor,
          context,
          evidenceBatch.id,
          evidenceBatch.rootHash,
          target,
        ),
        createEvidenceAnchorReservation(other).claimAnchorSubmission(
          actor,
          context,
          evidenceBatch.id,
          evidenceBatch.rootHash,
          target,
        ),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["acquired", "blocked"]);
      const winner = a.kind === "acquired" ? a : b;
      const loser = a.kind === "blocked" ? a : b;
      expect(winner).toMatchObject({
        kind: "acquired",
        reservationId: expect.any(String),
        claimToken: expect.any(String),
      });
      expect(loser).not.toHaveProperty("reservationId");
      expect(loser).not.toHaveProperty("claimToken");
      expect(await prisma.evidenceAnchorReservation.count()).toBe(1);
    } finally {
      await other.$disconnect();
    }
  });

  it("AC-DR04 preserves a claim across clients and separates targets", async () => {
    const { actor, context, batch } = await fixture();
    const evidenceBatch = await batch();
    const reservation = createEvidenceAnchorReservation(prisma);
    const first = await reservation.claimAnchorSubmission(
      actor,
      context,
      evidenceBatch.id,
      evidenceBatch.rootHash,
      target,
    );
    expect(first.kind).toBe("acquired");
    expect(first).toMatchObject({
      reservationId: expect.any(String),
      claimToken: expect.any(String),
    });
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      const fresh = createEvidenceAnchorReservation(other);
      const blocked = await fresh.claimAnchorSubmission(
        actor,
        context,
        evidenceBatch.id,
        evidenceBatch.rootHash,
        target,
      );
      expect(blocked.kind).toBe("blocked");
      expect(blocked).not.toHaveProperty("reservationId");
      expect(blocked).not.toHaveProperty("claimToken");
      const separate = await fresh.claimAnchorSubmission(
        actor,
        context,
        evidenceBatch.id,
        evidenceBatch.rootHash,
        { ...target, chainId: 1 },
      );
      expect(separate.kind).toBe("acquired");
      const separateContract = await fresh.claimAnchorSubmission(
        actor,
        context,
        evidenceBatch.id,
        evidenceBatch.rootHash,
        { ...target, contractAddress: otherContract },
      );
      expect(separateContract.kind).toBe("acquired");
      expect(await other.evidenceAnchorReservation.count()).toBe(3);
    } finally {
      await other.$disconnect();
    }
  });

  it("AC-DR02 rejects foreign ownership without leaking or claiming", async () => {
    const { actor, outsider, context, batch } = await fixture();
    const evidenceBatch = await batch();
    const reservation = createEvidenceAnchorReservation(prisma);
    await expect(
      reservation.claimAnchorSubmission(
        outsider,
        context,
        evidenceBatch.id,
        evidenceBatch.rootHash,
        target,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.evidenceAnchorReservation.count()).toBe(0);
    const acquired = await reservation.claimAnchorSubmission(
      actor,
      context,
      evidenceBatch.id,
      evidenceBatch.rootHash,
      target,
    );
    expect(acquired.kind).toBe("acquired");
    await expect(
      reservation.claimAnchorSubmission(
        outsider,
        context,
        evidenceBatch.id,
        evidenceBatch.rootHash,
        target,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await prisma.evidenceAnchorReservation.count()).toBe(1);
  });

  it("AC-DR01 rejects a mismatched or malformed target before persisting", async () => {
    const { actor, context, batch } = await fixture();
    const evidenceBatch = await batch();
    const claim = createEvidenceAnchorReservation(prisma).claimAnchorSubmission;
    await expect(
      claim(actor, context, evidenceBatch.id, `0x${"00".repeat(32)}`, target),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      claim(actor, context, evidenceBatch.id, evidenceBatch.rootHash, {
        ...target,
        chainId: 0,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      claim(actor, context, evidenceBatch.id, evidenceBatch.rootHash, {
        ...target,
        contractAddress: "invalid",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await prisma.evidenceAnchorReservation.count()).toBe(0);
  });

  it("AC-DR05 retains the reservation on ambiguous send and blocks a new connection", async () => {
    const { actor, context, batch } = await fixture();
    const evidenceBatch = await batch();
    let sends = 0;
    const client = createEvidenceAnchorClient(
      { ...target, signerAddress: fixtureSigner },
      {
        async getChainId() {
          return target.chainId;
        },
        async getSignerAddress() {
          return fixtureSigner;
        },
        async getContractSigner() {
          return fixtureSigner;
        },
        async isRootRegistered() {
          return false;
        },
        ...signedAnchorTransport(
          evidenceBatch.rootHash,
          target.contractAddress,
        ),
        async broadcastSignedTransaction() {
          sends++;
          throw new Error("Outcome unknown");
        },
      },
    );
    const persistence = {
      ...createEvidencePersistence(prisma),
      ...createEvidenceAnchorReservation(prisma),
    };
    await expect(
      createEvidenceAnchor(persistence, client).anchorBatch(
        actor,
        context,
        evidenceBatch.id,
      ),
    ).rejects.toThrow("Outcome unknown");
    const fresh = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      const next = {
        ...createEvidencePersistence(fresh),
        ...createEvidenceAnchorReservation(fresh),
      };
      await expect(
        createEvidenceAnchor(next, client).anchorBatch(
          actor,
          context,
          evidenceBatch.id,
        ),
      ).rejects.toThrow("already claimed");
      expect(sends).toBe(1);
      expect(await fresh.evidenceAnchorReservation.count()).toBe(1);
    } finally {
      await fresh.$disconnect();
    }
  });

  it("AC-DR03 enforces global target uniqueness for different batches (schema constraint only)", async () => {
    const { actor, context, batch } = await fixture();
    const valid = await batch();
    const first = await createEvidenceAnchorReservation(
      prisma,
    ).claimAnchorSubmission(actor, context, valid.id, valid.rootHash, target);
    expect(first.kind).toBe("acquired");
    // Deliberately synthetic: a second batch with the same root but another
    // owner cannot be made through the canonical batch API. It is NOT valid
    // reconstructed evidence; only the global SQL uniqueness is under test.
    const other = await prisma.user.create({
      data: { name: "Synthetic owner", rut: "123456801" },
    });
    const synthetic = await prisma.evidenceBatch.create({
      data: {
        organizationId: context.organizationId,
        ownerType: "USER",
        ownerId: other.id,
        policyVersion: "invoice-merkle-v2",
        rootHash: Buffer.from(valid.rootHash.slice(2), "hex"),
        leafCount: 1,
      },
    });
    await expect(
      prisma.evidenceAnchorReservation.create({
        data: {
          id: randomUUID(),
          claimToken: randomUUID(),
          chainId: BigInt(target.chainId),
          contractAddress: Buffer.from(target.contractAddress.slice(2), "hex"),
          rootHash: Buffer.from(valid.rootHash.slice(2), "hex"),
          batchId: synthetic.id,
          organizationId: context.organizationId,
          ownerType: "USER",
          ownerId: other.id,
          actorUserId: other.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.evidenceAnchorReservation.count()).toBe(1);
  });
});
