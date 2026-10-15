import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encodeEventTopics, encodeFunctionData, type Hex } from "viem";

import { createEvidenceAnchorObservations } from "../src/evidence-anchor-observations.js";
import {
  createEvidenceAnchorReconciliation,
  type ChainReceipt,
  type ChainTransaction,
} from "../src/evidence-anchor-reconciliation.js";
import { rootRegisteredAbi } from "../src/evidence-anchor-reconciliation-viem.js";
import { registerRootAbi } from "../src/evidence-anchor-client.js";
import { createEvidenceAnchorReservation } from "../src/evidence-anchor-reservation.js";
import { createEvidencePersistence } from "../src/evidence-persistence.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createInvoiceService } from "../src/invoices.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

const url = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url }),
});
const signer = `0x${"11".repeat(20)}` as Hex;
const target = {
  chainId: 31337,
  contractAddress: `0x${"22".repeat(20)}` as Hex,
};
const hash = `0x${"33".repeat(32)}` as Hex;
const blockHash = `0x${"44".repeat(32)}` as Hex;

async function reset() {
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
    data: { name: "Reconciliation", slug: "reconciliation" },
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
  const invoice = await prisma.invoice.create({
    data: {
      invoiceId: "RC-1",
      organizationId: organization.id,
      ownerType: "USER",
      ownerId: actor.id,
      createdByUserId: actor.id,
      vendorName: "Vendor",
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
  await createInvoiceService(prisma).decideInvoice(
    actor,
    context,
    invoice.invoiceId,
    { mode: "RULE_V1" },
  );
  const record = await prisma.evidenceRecord.findFirstOrThrow({
    where: { invoiceRecordId: invoice.id },
  });
  const batch = await createEvidencePersistence(prisma).createBatch(
    actor,
    context,
    [record.id],
  );
  const claims = createEvidenceAnchorReservation(prisma);
  const claim = await claims.claimAnchorSubmission(
    actor,
    context,
    batch.id,
    batch.rootHash,
    target,
  );
  if (claim.kind !== "acquired") throw new Error("Expected reservation");
  await claims.acquireSignerPreparationSlot(
    actor,
    context,
    batch.id,
    batch.rootHash,
    target,
    claim.reservationId,
    claim.claimToken,
    signer,
  );
  await claims.persistPreparedTransaction(
    actor,
    context,
    batch.id,
    claim.reservationId,
    claim.claimToken,
    {
      chainId: 31337,
      signerAddress: signer,
      contractAddress: target.contractAddress,
      root: batch.rootHash,
      nonce: 7,
      gas: 90_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      transactionHash: hash,
    },
  );
  const root = batch.rootHash as Hex;
  const tx: ChainTransaction = {
    hash,
    chainId: 31337,
    type: "eip1559",
    from: signer,
    to: target.contractAddress,
    input: encodeFunctionData({
      abi: registerRootAbi,
      functionName: "registerRoot",
      args: [root],
    }),
    nonce: 7,
    gas: 90_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
    blockHash,
    blockNumber: 4n,
  };
  const topics = encodeEventTopics({
    abi: rootRegisteredAbi,
    eventName: "RootRegistered",
    args: { rootHash: root, signer },
  }).filter((topic): topic is Hex => typeof topic === "string");
  const receipt: ChainReceipt = {
    transactionHash: hash,
    from: signer,
    to: target.contractAddress,
    status: "success",
    blockHash,
    blockNumber: 4n,
    logs: [
      {
        address: target.contractAddress,
        topics,
        data: "0x",
        blockHash,
        blockNumber: 4n,
        transactionHash: hash,
        removed: false,
      },
    ],
  };
  return { actor, outsider, context, batch, claim, tx, receipt };
}

describe("TX06 append-only PostgreSQL boundary", () => {
  it("persists canonical then contrary observations across clients and rejects foreign reading and mutation", async () => {
    const f = await fixture();
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    let canonical = blockHash;
    let requests = 0;
    const reader = {
      async getChainId() {
        requests++;
        return 31337;
      },
      async getContractSigner() {
        return signer;
      },
      async getTransaction() {
        return f.tx;
      },
      async getReceipt() {
        return f.receipt;
      },
      async getCanonicalBlock() {
        return { number: 4n, hash: canonical };
      },
    };
    const store = createEvidenceAnchorObservations(prisma);
    const check = () =>
      createEvidenceAnchorReconciliation(store, reader).check(
        f.actor,
        f.context,
        f.batch.id,
        f.claim.reservationId,
      );
    try {
      await expect(
        createEvidenceAnchorReconciliation(store, reader).check(
          f.outsider,
          f.context,
          f.batch.id,
          f.claim.reservationId,
        ),
      ).rejects.toThrow();
      expect(requests).toBe(0);
      await expect(check()).resolves.toMatchObject({ kind: "observedSuccess" });
      canonical = hash;
      await expect(check()).resolves.toMatchObject({ kind: "orphaned" });
      expect(
        (
          await other.evidenceAnchorObservation.findMany({
            orderBy: [{ checkedAt: "asc" }, { id: "asc" }],
          })
        )
          .map((o) => o.kind)
          .sort(),
      ).toEqual(["observedSuccess", "orphaned"]);
      const row = await other.evidenceAnchorObservation.findFirstOrThrow();
      await expect(
        other.evidenceAnchorObservation.update({
          where: { id: row.id },
          data: { kind: "pending" },
        }),
      ).rejects.toThrow();
      await expect(
        other.evidenceAnchorObservation.delete({ where: { id: row.id } }),
      ).rejects.toThrow();
      expect(await other.evidenceAnchorObservation.count()).toBe(2);
      await expect(
        store.readPrepared(
          f.actor,
          { ...f.context, ownerId: f.outsider.id },
          f.batch.id,
          f.claim.reservationId,
        ),
      ).rejects.toThrow();
    } finally {
      await other.$disconnect();
    }
  });

  it("rejects malformed SQL observation fields and does not modify prepared history", async () => {
    const f = await fixture();
    const store = createEvidenceAnchorObservations(prisma);
    await expect(
      store.append(f.actor, f.context, f.batch.id, f.claim.reservationId, {
        kind: "observedSuccess",
        reason: "matched",
        blockHash: "0x00",
        blockNumber: 4n,
        receiptStatus: "success",
      }),
    ).rejects.toThrow();
    await expect(
      store.append(f.actor, f.context, f.batch.id, f.claim.reservationId, {
        kind: "observedSuccess",
        reason: "matched",
      }),
    ).rejects.toThrow();
    expect(await prisma.evidenceAnchorObservation.count()).toBe(0);
    expect(await prisma.evidencePreparedAnchorTransaction.count()).toBe(1);
  });
});
