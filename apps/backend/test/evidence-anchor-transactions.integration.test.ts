import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, keccak256, type Hex } from "viem";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { createEvidenceAnchorReservation } from "../src/evidence-anchor-reservation.js";
import {
  createEvidenceAnchorClient,
  registerRootAbi,
} from "../src/evidence-anchor-client.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import { createEvidencePersistence } from "../src/evidence-persistence.js";
import { createInvoiceService } from "../src/invoices.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const account = privateKeyToAccount(generatePrivateKey());
const signerAddress = account.address.toLowerCase();
const target = { chainId: 31337, contractAddress: `0x${"12".repeat(20)}` };

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
    data: { name: "Transaction organization", slug: "transaction-org" },
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
  let number = 0;
  async function batch() {
    number++;
    const invoice = await prisma.invoice.create({
      data: {
        invoiceId: `TX-${number}`,
        organizationId: organization.id,
        ownerType: "USER",
        ownerId: actor.id,
        createdByUserId: actor.id,
        vendorName: "Vendor",
        invoiceAmountCents: number,
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

describe("APP-11 durable signer and prepared transaction PostgreSQL boundary", () => {
  it("TX01/TX04 denies invalid token/actor/target before slot and elects one independent client across different batches", async () => {
    const { actor, outsider, context, batch } = await fixture();
    const [firstBatch, secondBatch] = [await batch(), await batch()];
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    try {
      const a = createEvidenceAnchorReservation(prisma);
      const b = createEvidenceAnchorReservation(other);
      const first = await a.claimAnchorSubmission(
        actor,
        context,
        firstBatch.id,
        firstBatch.rootHash,
        target,
      );
      const second = await b.claimAnchorSubmission(
        actor,
        context,
        secondBatch.id,
        secondBatch.rootHash,
        { ...target, contractAddress: `0x${"13".repeat(20)}` },
      );
      if (first.kind !== "acquired" || second.kind !== "acquired")
        throw new Error("Expected distinct reservations");
      const args = [
        actor,
        context,
        firstBatch.id,
        firstBatch.rootHash,
        target,
        first.reservationId,
        first.claimToken,
        signerAddress,
      ] as const;
      await expect(
        a.acquireSignerPreparationSlot(
          actor,
          context,
          firstBatch.id,
          firstBatch.rootHash,
          target,
          first.reservationId,
          "wrong-token",
          signerAddress,
        ),
      ).rejects.toThrow();
      await expect(
        a.acquireSignerPreparationSlot(
          outsider,
          context,
          firstBatch.id,
          firstBatch.rootHash,
          target,
          first.reservationId,
          first.claimToken,
          signerAddress,
        ),
      ).rejects.toThrow();
      await expect(
        a.acquireSignerPreparationSlot(
          actor,
          context,
          firstBatch.id,
          firstBatch.rootHash,
          { ...target, contractAddress: `0x${"14".repeat(20)}` },
          first.reservationId,
          first.claimToken,
          signerAddress,
        ),
      ).rejects.toThrow();
      expect(await prisma.evidenceSignerPreparationSlot.count()).toBe(0);
      const results = await Promise.allSettled([
        a.acquireSignerPreparationSlot(...args),
        b.acquireSignerPreparationSlot(
          actor,
          context,
          secondBatch.id,
          secondBatch.rootHash,
          { ...target, contractAddress: `0x${"13".repeat(20)}` },
          second.reservationId,
          second.claimToken,
          signerAddress,
        ),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(await other.evidenceSignerPreparationSlot.count()).toBe(1);
      const winner =
        await other.evidenceSignerPreparationSlot.findFirstOrThrow();
      const next =
        winner.reservationId === first.reservationId ? second : first;
      const nextBatch =
        winner.reservationId === first.reservationId ? secondBatch : firstBatch;
      await expect(
        b.acquireSignerPreparationSlot(
          actor,
          context,
          nextBatch.id,
          nextBatch.rootHash,
          {
            ...target,
            contractAddress:
              winner.reservationId === first.reservationId
                ? `0x${"13".repeat(20)}`
                : target.contractAddress,
          },
          next.reservationId,
          next.claimToken,
          signerAddress,
        ),
      ).rejects.toThrow();
    } finally {
      await other.$disconnect();
    }
  });

  it("TX02/TX03 commits independently visible hash before exact raw-send, retains claim on unknown outcome", async () => {
    const { actor, context, batch } = await fixture();
    const evidenceBatch = await batch();
    const other = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const persistent = {
      ...createEvidencePersistence(prisma),
      ...createEvidenceAnchorReservation(prisma),
    };
    let sends = 0;
    const transport = {
      async getChainId() {
        return 31337;
      },
      async getSignerAddress() {
        return signerAddress;
      },
      async getContractSigner() {
        return signerAddress;
      },
      async isRootRegistered() {
        return false;
      },
      async getPendingNonce() {
        return 7;
      },
      async prepareRootRegistration(
        _contract: string,
        root: Hex,
        nonce: number,
      ) {
        return account.signTransaction({
          type: "eip1559",
          chainId: 31337,
          to: target.contractAddress as Hex,
          nonce,
          data: encodeFunctionData({
            abi: registerRootAbi,
            functionName: "registerRoot",
            args: [root],
          }),
          value: 0n,
          gas: 90_000n,
          maxFeePerGas: 2_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
      },
      async broadcastSignedTransaction(raw: Hex) {
        sends++;
        const row =
          await other.evidencePreparedAnchorTransaction.findFirstOrThrow();
        expect(`0x${Buffer.from(row.transactionHash).toString("hex")}`).toBe(
          keccak256(raw),
        );
        throw new Error("Outcome unknown");
      },
    };
    const client = createEvidenceAnchorClient(
      { ...target, signerAddress },
      transport,
    );
    try {
      await expect(
        createEvidenceAnchor(persistent, client).anchorBatch(
          actor,
          context,
          evidenceBatch.id,
        ),
      ).rejects.toThrow("Outcome unknown");
      expect(sends).toBe(1);
      expect(await other.evidenceSignerPreparationSlot.count()).toBe(1);
      expect(await other.evidencePreparedAnchorTransaction.count()).toBe(1);
      await expect(
        createEvidenceAnchor(
          {
            ...createEvidencePersistence(other),
            ...createEvidenceAnchorReservation(other),
          },
          client,
        ).anchorBatch(actor, context, evidenceBatch.id),
      ).rejects.toThrow("already claimed");
      expect(sends).toBe(1);
      const columns = await other.$queryRaw<
        { column_name: string }[]
      >`SELECT column_name FROM information_schema.columns WHERE table_name = 'EvidencePreparedAnchorTransaction'`;
      expect(columns.map((column) => column.column_name)).not.toContain(
        "signedTransaction",
      );
      const record = await other.evidenceAnchorReservation.findFirstOrThrow();
      await expect(
        persistent.persistPreparedTransaction(
          actor,
          context,
          evidenceBatch.id,
          record.id,
          "wrong-token",
          {
            chainId: 31337,
            signerAddress,
            contractAddress: target.contractAddress,
            root: evidenceBatch.rootHash,
            nonce: 8,
            gas: 90_000n,
            maxFeePerGas: 2_000_000_000n,
            maxPriorityFeePerGas: 1_000_000_000n,
            transactionHash: `0x${"45".repeat(32)}`,
          },
        ),
      ).rejects.toThrow();
      expect(await other.evidencePreparedAnchorTransaction.count()).toBe(1);
    } finally {
      await other.$disconnect();
    }
  });

  it("TX04 permits separate chains or signers while preserving the global account fence", async () => {
    const { actor, context, batch } = await fixture();
    const [first, second, third] = [
      await batch(),
      await batch(),
      await batch(),
    ];
    const adapter = createEvidenceAnchorReservation(prisma);
    const claims = await Promise.all([
      adapter.claimAnchorSubmission(
        actor,
        context,
        first.id,
        first.rootHash,
        target,
      ),
      adapter.claimAnchorSubmission(
        actor,
        context,
        second.id,
        second.rootHash,
        { ...target, chainId: 1 },
      ),
      adapter.claimAnchorSubmission(actor, context, third.id, third.rootHash, {
        ...target,
        contractAddress: `0x${"13".repeat(20)}`,
      }),
    ]);
    if (claims.some((claim) => claim.kind !== "acquired"))
      throw new Error("Distinct roots must be reserved");
    const [a, b, c] = claims.map((claim) => {
      if (claim.kind !== "acquired") throw new Error("Missing claim");
      return claim;
    });
    await adapter.acquireSignerPreparationSlot(
      actor,
      context,
      first.id,
      first.rootHash,
      target,
      a.reservationId,
      a.claimToken,
      signerAddress,
    );
    await adapter.acquireSignerPreparationSlot(
      actor,
      context,
      second.id,
      second.rootHash,
      { ...target, chainId: 1 },
      b.reservationId,
      b.claimToken,
      signerAddress,
    );
    const differentSigner = privateKeyToAccount(generatePrivateKey()).address;
    await adapter.acquireSignerPreparationSlot(
      actor,
      context,
      third.id,
      third.rootHash,
      { ...target, contractAddress: `0x${"13".repeat(20)}` },
      c.reservationId,
      c.claimToken,
      differentSigner,
    );
    expect(await prisma.evidenceSignerPreparationSlot.count()).toBe(3);
  });

  it("TX08 isolates prepared hash and nonce checks on a valid unprepared slot; retains append-only state", async () => {
    const { actor, context, batch } = await fixture();
    const first = await batch();
    const adapter = createEvidenceAnchorReservation(prisma);
    const claim = await adapter.claimAnchorSubmission(
      actor,
      context,
      first.id,
      first.rootHash,
      target,
    );
    if (claim.kind !== "acquired") throw new Error("Missing claim");
    await adapter.acquireSignerPreparationSlot(
      actor,
      context,
      first.id,
      first.rootHash,
      target,
      claim.reservationId,
      claim.claimToken,
      signerAddress,
    );
    const metadata = {
      chainId: 31337,
      signerAddress,
      contractAddress: target.contractAddress,
      root: first.rootHash,
      nonce: 7,
      gas: 90_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      transactionHash: `0x${"45".repeat(32)}` as Hex,
    };
    // Synthetic SQL-negative fixture: the canonical API cannot submit malformed
    // metadata. All FK columns match the real reserved slot; only the tested
    // non-FK field is invalid in each statement.
    const slot = await prisma.evidenceSignerPreparationSlot.findUniqueOrThrow({
      where: { reservationId: claim.reservationId },
    });
    const checks = await prisma.$queryRaw<
      { conname: string; definition: string }[]
    >`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid = to_regclass('public."EvidencePreparedAnchorTransaction"')
        AND c.conname IN ('EvidencePreparedAnchorTransaction_hash_check', 'EvidencePreparedAnchorTransaction_nonce_check')
      ORDER BY c.conname
    `;
    expect(checks.map(({ conname }) => conname)).toEqual([
      "EvidencePreparedAnchorTransaction_hash_check",
      "EvidencePreparedAnchorTransaction_nonce_check",
    ]);
    expect(checks[0].definition).toContain(
      'octet_length("transactionHash") = 32',
    );
    expect(checks[1].definition).toContain("nonce");
    async function insertSyntheticPrepared(nonce: bigint, hash: Buffer) {
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "EvidencePreparedAnchorTransaction"
            ("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "transactionHash")
          VALUES
            (${slot.reservationId}, ${slot.chainId}, ${slot.signerAddress}, ${slot.contractAddress}, ${slot.rootHash}, ${nonce}, ${metadata.gas}, ${metadata.maxFeePerGas}, ${metadata.maxPriorityFeePerGas}, ${hash})
        `;
      });
    }
    await expect(
      insertSyntheticPrepared(7n, Buffer.alloc(1)),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
    });
    await expect(
      insertSyntheticPrepared(
        -1n,
        Buffer.from(metadata.transactionHash.slice(2), "hex"),
      ),
    ).rejects.toMatchObject({
      code: "P2010",
      meta: { driverAdapterError: { cause: { originalCode: "23514" } } },
    });
    expect(await prisma.evidencePreparedAnchorTransaction.count()).toBe(0);
    await adapter.persistPreparedTransaction(
      actor,
      context,
      first.id,
      claim.reservationId,
      claim.claimToken,
      metadata,
    );
    await expect(
      adapter.persistPreparedTransaction(
        actor,
        context,
        first.id,
        claim.reservationId,
        claim.claimToken,
        metadata,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.evidencePreparedAnchorTransaction.update({
        where: { reservationId: claim.reservationId },
        data: { nonce: 8n },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.evidenceSignerPreparationSlot.delete({
        where: { reservationId: claim.reservationId },
      }),
    ).rejects.toThrow();
    expect(await prisma.evidencePreparedAnchorTransaction.count()).toBe(1);
    // Catalog proof only: the slot primary key makes a second valid slot for
    // the same chain/signer impossible; a nonce collision cannot be presented
    // as a valid two-reservation behavioral test under this schema.
    const indexes = await prisma.$queryRaw<
      { tablename: string; indexname: string; indexdef: string }[]
    >`
      SELECT tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN
        ('EvidenceSignerPreparationSlot_pkey', 'EvidencePreparedAnchorTransaction_pkey', 'EvidencePreparedAnchorTransaction_nonce_key')
      ORDER BY indexname
    `;
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "EvidencePreparedAnchorTransaction_nonce_key",
      "EvidencePreparedAnchorTransaction_pkey",
      "EvidenceSignerPreparationSlot_pkey",
    ]);
    const byName = new Map(
      indexes.map(({ indexname, indexdef }) => [indexname, indexdef]),
    );
    expect(byName.get("EvidenceSignerPreparationSlot_pkey")).toMatch(
      /UNIQUE INDEX.*\("chainId", "signerAddress"\)/,
    );
    expect(byName.get("EvidencePreparedAnchorTransaction_pkey")).toMatch(
      /UNIQUE INDEX.*\("reservationId"\)/,
    );
    expect(byName.get("EvidencePreparedAnchorTransaction_nonce_key")).toMatch(
      /UNIQUE INDEX.*\("chainId", "signerAddress", nonce\)/,
    );
  });
});
