import { PrismaPg } from "@prisma/adapter-pg";
import { createServer } from "node:http";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AuthError, createAuthService } from "../src/auth.js";
import { provisionInternalUser } from "../src/internal-user-provisioning.js";
import { createEvidenceAnchorCommand } from "../src/evidence-anchor-command.js";
import { runEvidenceAnchorCli } from "../src/evidence-anchor-cli.js";
import { createEvidenceAnchorObservations } from "../src/evidence-anchor-observations.js";
import { createEvidenceAnchorReservation } from "../src/evidence-anchor-reservation.js";
import { createEvidenceAnchorTransactions } from "../src/evidence-anchor-transactions.js";
import { createEvidencePersistence } from "../src/evidence-persistence.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createInvoiceService } from "../src/invoices.js";
import { authorizeContext } from "../src/invoices.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const auth = createAuthService(prisma);
const privateKey = generatePrivateKey();
const signer = privateKeyToAccount(privateKey).address;
const contractAddress = `0x${"11".repeat(20)}`;

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "EvidenceAnchorObservation", "EvidencePreparedAnchorTransaction", "EvidenceSignerPreparationSlot", "EvidenceAnchorReservation", "EvidenceBatchItem", "EvidenceBatch", "EvidenceRecord"',
  );
  // Reset protected platform-admin rows only inside the isolated test database.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PlatformAdministrativeAuditEvent", "PlatformAdministrator"',
  );
  await prisma.session.deleteMany();
  await prisma.decisionEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.groupMembership.deleteMany();
  await prisma.group.deleteMany();
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
  const actor = await provisionInternalUser(prisma, {
    name: "CLI Operator",
    rut: "12.345.678-5",
    password: "synthetic-password-123",
  });
  const { sessionToken } = await auth.login({
    rut: "12.345.678-5",
    password: "synthetic-password-123",
  });
  const outsider = await provisionInternalUser(prisma, {
    name: "CLI Outsider",
    rut: "12.345.679-3",
    password: "synthetic-password-456",
  });
  const organization = await prisma.organization.create({
    data: { name: "CLI Organization", slug: "cli-organization" },
  });
  await prisma.organizationMembership.create({
    data: {
      userId: actor.id,
      organizationId: organization.id,
      role: "STUDENT",
    },
  });
  await prisma.platformAdministrator.create({ data: { userId: actor.id } });
  const group = await prisma.group.create({
    data: { organizationId: organization.id, name: "Authorized group" },
  });
  const foreignGroup = await prisma.group.create({
    data: { organizationId: organization.id, name: "Foreign group" },
  });
  await prisma.groupMembership.create({
    data: {
      organizationId: organization.id,
      groupId: group.id,
      userId: actor.id,
    },
  });
  const context = {
    organizationId: organization.id,
    ownerType: "user" as const,
    ownerId: actor.id,
  };
  const invoice = await prisma.invoice.create({
    data: {
      invoiceId: "CLI-INVOICE",
      organizationId: organization.id,
      ownerType: "USER",
      ownerId: actor.id,
      createdByUserId: actor.id,
      vendorName: "CLI vendor",
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
  const evidence = await prisma.evidenceRecord.findFirstOrThrow({
    where: { invoiceRecordId: invoice.id },
  });
  const batch = await createEvidencePersistence(prisma).createBatch(
    actor,
    context,
    [evidence.id],
  );
  return {
    actor,
    outsider,
    sessionToken,
    organization,
    group,
    foreignGroup,
    context,
    batch,
  };
}

function cli(runtimeCalls: () => void) {
  return createEvidenceAnchorCommand({
    authenticateSession: (token) => auth.getProfile(token),
    data: {
      ...createEvidencePersistence(prisma),
      ...createEvidenceAnchorReservation(prisma),
      ...createEvidenceAnchorTransactions(prisma),
      ...createEvidenceAnchorObservations(prisma),
      authorizeContext: (actorId, context) =>
        authorizeContext(prisma, actorId, context),
    },
    createEvmRuntime: () => {
      runtimeCalls();
      return {
        transport: {
          getChainId: async () => 31337,
          getSignerAddress: async () => signer,
          getContractSigner: async () => signer,
          isRootRegistered: async () => true,
          getPendingNonce: async () => 0,
          prepareRootRegistration: async () => {
            throw new Error("unexpected transaction preparation");
          },
          broadcastSignedTransaction: async () => {
            throw new Error("unexpected transaction broadcast");
          },
        },
        chainReader: {
          getChainId: async () => 31337,
          getContractSigner: async () => signer,
          getTransaction: async () => null,
          getReceipt: async () => null,
          getCanonicalBlock: async () => ({ number: null, hash: null }),
        },
      };
    },
  });
}

function anchorArgs(organizationId: string, ownerId: string) {
  return [
    "anchor",
    "--batch-id",
    "batch",
    "--organization-id",
    organizationId,
    "--owner-type",
    "user",
    "--owner-id",
    ownerId,
  ];
}

const env = (sessionToken: string) => ({
  APP_SESSION_TOKEN: sessionToken,
  EVM_RPC_URL: "https://rpc.example.invalid",
  EVM_CHAIN_ID: "31337",
  EVIDENCE_CONTRACT_ADDRESS: contractAddress,
  EVM_SIGNER_PRIVATE_KEY: privateKey,
});

describe("APP-11 CLI real PostgreSQL authorization", () => {
  it("authenticates a real session, rechecks self-owner ACL, and returns only already-registered status", async () => {
    const { actor, sessionToken, organization, batch } = await fixture();
    const runtimeCalls = vi.fn();
    const command = cli(runtimeCalls);
    const args = anchorArgs(organization.id, actor.id);
    args[2] = batch.id;

    const result = await command.execute(args, env(sessionToken));

    expect(result).toMatchObject({
      kind: "alreadyRegistered",
      batchId: batch.id,
      rootHash: batch.rootHash,
    });
    expect(runtimeCalls).toHaveBeenCalledOnce();
    expect(await prisma.evidenceAnchorReservation.count()).toBe(0);
    expect(JSON.stringify(result)).not.toContain(sessionToken);
    expect(JSON.stringify(result)).not.toContain(privateKey);
    expect(JSON.stringify(result)).not.toContain("rpc.example.invalid");
  });

  it("does not allow a platform administrator's valid session to bypass group membership ACL", async () => {
    const { sessionToken, organization, foreignGroup } = await fixture();
    const runtimeCalls = vi.fn();
    const command = cli(runtimeCalls);
    const args = [
      "anchor",
      "--batch-id",
      "batch-id",
      "--organization-id",
      organization.id,
      "--owner-type",
      "group",
      "--owner-id",
      foreignGroup.id,
    ];

    await expect(
      command.execute(args, env(sessionToken)),
    ).rejects.toMatchObject({ status: 404 });
    expect(runtimeCalls).not.toHaveBeenCalled();
    expect(await prisma.evidenceAnchorReservation.count()).toBe(0);
  });

  it("rejects missing, foreign, and expired session tokens before constructing an EVM runtime", async () => {
    const { actor, outsider, sessionToken, organization } = await fixture();
    const runtimeCalls = vi.fn();
    const command = cli(runtimeCalls);
    const args = anchorArgs(organization.id, actor.id);
    const foreign = await auth.login({
      rut: "12.345.679-3",
      password: "synthetic-password-456",
    });

    await expect(
      command.execute(args, {
        ...env(sessionToken),
        APP_SESSION_TOKEN: undefined,
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      command.execute(args, {
        ...env(sessionToken),
        APP_SESSION_TOKEN: "foreign-invalid-token",
      }),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      command.execute(args, {
        ...env(sessionToken),
        APP_SESSION_TOKEN: foreign.sessionToken,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.session.updateMany({
      where: { userId: outsider.id },
      data: { expiresAt: new Date(0) },
    });
    const expired = foreign;
    await expect(
      command.execute(args, {
        ...env(sessionToken),
        APP_SESSION_TOKEN: expired.sessionToken,
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(runtimeCalls).not.toHaveBeenCalled();
  });

  it("keeps CLI failures generic while exposing only fixed diagnostic categories", async () => {
    const { actor, sessionToken, organization, batch } = await fixture();
    const args = anchorArgs(organization.id, actor.id);
    args[2] = batch.id;
    const privateKey = generatePrivateKey();
    const sensitiveEnvironment = {
      DATABASE_URL: databaseUrl,
      EVM_RPC_URL:
        "https://user:synthetic-url-secret@rpc.example.invalid/path?token=synthetic-query-secret",
      EVM_CHAIN_ID: "31337",
      EVIDENCE_CONTRACT_ADDRESS: contractAddress,
      EVM_SIGNER_PRIVATE_KEY: privateKey,
    };
    const invoke = async (
      commandArgs: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => {
      const output: string[] = [];
      const diagnostics: unknown[] = [];
      const status = await runEvidenceAnchorCli(
        commandArgs,
        environment,
        (line) => output.push(line),
        (event) => diagnostics.push(event),
      );
      return { status, output, diagnostics };
    };
    const containsSensitiveValue = (value: unknown) => {
      const serialized = JSON.stringify(value);
      return [
        databaseUrl,
        privateKey,
        sessionToken,
        "synthetic-url-secret",
        "synthetic-query-secret",
        "synthetic-rpc-body-secret",
        "synthetic-cause-secret",
      ].some((secret) => serialized.includes(secret));
    };

    const unauthenticated = await invoke(args, sensitiveEnvironment);
    expect(unauthenticated).toMatchObject({
      status: 1,
      output: [JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" })],
      diagnostics: [
        {
          phase: "execute",
          operation: "anchor",
          reason: "authentication",
          outcome: "failed",
        },
      ],
    });
    expect(containsSensitiveValue(unauthenticated)).toBe(false);

    const foreignLogin = await auth.login({
      rut: "12.345.679-3",
      password: "synthetic-password-456",
    });
    const foreign = await invoke(args, {
      ...sensitiveEnvironment,
      APP_SESSION_TOKEN: foreignLogin.sessionToken,
    });
    expect(foreign).toMatchObject({
      status: 1,
      output: [JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" })],
      diagnostics: [
        {
          phase: "execute",
          operation: "anchor",
          reason: "data",
          outcome: "failed",
        },
      ],
    });
    expect(containsSensitiveValue(foreign)).toBe(false);

    const inaccessibleArgs = [...args];
    inaccessibleArgs[2] = "synthetic-inaccessible-batch";
    const inaccessible = await invoke(inaccessibleArgs, {
      ...sensitiveEnvironment,
      APP_SESSION_TOKEN: sessionToken,
    });
    expect(inaccessible.diagnostics).toEqual([
      {
        phase: "execute",
        operation: "anchor",
        reason: "data",
        outcome: "failed",
      },
    ]);
    expect(inaccessible.output).toEqual([
      JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }),
    ]);
    expect(containsSensitiveValue(inaccessible)).toBe(false);

    const invalidConfig = await invoke(args, {
      ...sensitiveEnvironment,
      APP_SESSION_TOKEN: sessionToken,
      EVM_RPC_URL: sensitiveEnvironment.EVM_RPC_URL,
    });
    expect(invalidConfig).toMatchObject({
      status: 2,
      output: [JSON.stringify({ error: "EVIDENCE_ANCHOR_CONFIG_INVALID" })],
      diagnostics: [
        {
          phase: "execute",
          operation: "anchor",
          reason: "configuration",
          outcome: "failed",
        },
      ],
    });
    expect(containsSensitiveValue(invalidConfig)).toBe(false);

    const provider = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "synthetic-rpc-body-secret" }));
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("Expected owned loopback provider fixture");
    try {
      const providerFailure = await invoke(args, {
        ...sensitiveEnvironment,
        APP_SESSION_TOKEN: sessionToken,
        EVM_RPC_URL: `http://127.0.0.1:${address.port}`,
      });
      expect(providerFailure).toMatchObject({
        status: 1,
        output: [JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" })],
        diagnostics: [
          {
            phase: "execute",
            operation: "anchor",
            reason: "operation",
            outcome: "failed",
          },
        ],
      });
      expect(containsSensitiveValue(providerFailure)).toBe(false);
      expect(await prisma.evidenceAnchorReservation.count()).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
