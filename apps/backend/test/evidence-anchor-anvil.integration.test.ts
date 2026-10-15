import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";

import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  encodeDeployData,
  decodeEventLog,
  keccak256,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import { createViemEvidenceAnchorTransport } from "../src/evidence-anchor-viem.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import { createEvidenceAnchorReservation } from "../src/evidence-anchor-reservation.js";
import { createEvidenceAnchorObservations } from "../src/evidence-anchor-observations.js";
import { createEvidenceAnchorReconciliation } from "../src/evidence-anchor-reconciliation.js";
import {
  createViemEvidenceAnchorReader,
  rootRegisteredAbi,
} from "../src/evidence-anchor-reconciliation-viem.js";
import { createEvidencePersistence } from "../src/evidence-persistence.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createAuthService } from "../src/auth.js";
import { createInvoiceService } from "../src/invoices.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";
import {
  checkOwnedListener,
  formatSmokeFailure,
  reportSmokeFailure,
  runOwnedChild,
} from "../scripts/test-anchor-anvil.mjs";
import { createOwnedAnvilRpc } from "./owned-anvil-rpc.mjs";

const url = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pid = Number(process.env.APP11_OWN_ANVIL_PID);
const port = Number(process.env.APP11_OWN_ANVIL_PORT);
if (
  !Number.isSafeInteger(pid) ||
  pid <= 0 ||
  !Number.isSafeInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error("Owned Anvil identity required");
const contractsRoot = resolve("../../../invoiceops-contracts");
const signerAbi = [
  {
    type: "function",
    name: "signer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
const readAbi = [
  {
    type: "function",
    name: "isRootRegistered",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;
const constructorAbi = [
  {
    type: "constructor",
    inputs: [{ type: "address", name: "allowedSigner" }],
    stateMutability: "nonpayable",
  },
] as const;

async function createOwnedAnvilRelay(options: {
  pid: number;
  port: number;
  observer: PrismaClient;
  batchId: string;
}) {
  let rawSendCount = 0;
  let requestCount = 0;
  let transactionHash: Hex | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const data = Buffer.from(chunk);
        size += data.length;
        if (size > 256 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(data);
      }
      const body = Buffer.concat(chunks);
      const rpc = JSON.parse(body.toString("utf8")) as {
        method?: unknown;
        params?: unknown;
      };
      if (rpc.method === "eth_sendRawTransaction") {
        if (
          rawSendCount !== 0 ||
          !Array.isArray(rpc.params) ||
          typeof rpc.params[0] !== "string" ||
          !/^0x(?:[0-9a-fA-F]{2})+$/.test(rpc.params[0])
        )
          throw new Error("Unexpected raw transaction boundary");
        const hash = keccak256(rpc.params[0] as Hex);
        const prepared =
          await options.observer.evidencePreparedAnchorTransaction.findFirst({
            where: { reservation: { batchId: options.batchId } },
          });
        if (
          !prepared ||
          `0x${Buffer.from(prepared.transactionHash).toString("hex")}` !== hash
        )
          throw new Error("Prepared transaction was not committed before send");
        transactionHash = hash;
        rawSendCount += 1;
      }
      requestCount += 1;
      checkOwnedListener(options.pid, options.port);
      const upstream = await fetch(`http://127.0.0.1:${options.port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      if (upstreamBody.length > 256 * 1024) {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "content-length": upstreamBody.length,
      });
      response.end(upstreamBody);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned local relay did not bind a loopback port");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const endpointUrl = new URL(endpoint);
  if (
    endpointUrl.hostname !== "127.0.0.1" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash
  )
    throw new Error("Owned local relay endpoint rejected");
  return {
    endpoint,
    get rawSendCount() {
      return rawSendCount;
    },
    get requestCount() {
      return requestCount;
    },
    get transactionHash() {
      return transactionHash;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function offlineBytecode() {
  const source = resolve(contractsRoot, "src/EvidenceRootAnchor.sol");
  const before = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  const result = spawnSync(
    "forge",
    [
      "inspect",
      "src/EvidenceRootAnchor.sol:EvidenceRootAnchor",
      "bytecode",
      "--offline",
    ],
    {
      cwd: contractsRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 256_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FOUNDRY_OFFLINE: "true",
      },
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Offline contract compilation unavailable");
  if (
    createHash("sha256").update(readFileSync(source)).digest("hex") !== before
  )
    throw new Error("Contract source changed during compilation");
  const bytecode = result.stdout.trim();
  if (!/^0x[0-9a-fA-F]{100,}$/.test(bytecode))
    throw new Error("Invalid offline contract bytecode");
  return bytecode as Hex;
}

describe("APP11 opt-in own-local Anvil and PostgreSQL smoke", () => {
  it("proves preparation before send and observed registration without finality or slot release", async () => {
    checkOwnedListener(pid, port); // No RPC, including health or eth_accounts, before this check.
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    const observer = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url }),
    });
    let phase = "startup";
    let step = "smoke-assertions";
    let rawSends = 0;
    let relay: Awaited<ReturnType<typeof createOwnedAnvilRelay>> | undefined;
    const rpc = createOwnedAnvilRpc({
      pid,
      port,
      assertOwner: checkOwnedListener,
      fetchResponse: fetch,
    });
    const provider = {
      async request({
        method,
        params,
      }: {
        method: string;
        params?: readonly unknown[];
      }) {
        if (method === "eth_sendRawTransaction") rawSends++;
        return rpc.request(method, params);
      },
    };
    const publicClient = createPublicClient({
      transport: custom(provider, { retryCount: 0 }),
    });
    const receiptFor = async (hash: Hex) => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const receipt = await publicClient
          .getTransactionReceipt({ hash })
          .catch(() => null);
        if (receipt) return receipt;
        await delay(250);
      }
      throw new Error("Owned receipt read timed out; write outcome unknown");
    };
    try {
      expect(await publicClient.getChainId()).toBe(31337);
      console.info(
        "SM01: verified owned listener and chain 31337 with fresh isolated DB",
      );
      phase = "compile-deploy";
      const bytecode = offlineBytecode();
      const signerPrivateKey = generatePrivateKey(); // In memory only.
      const account = privateKeyToAccount(signerPrivateKey);
      const dev = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      expect(dev).toHaveLength(10);
      const fundHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          { from: dev[0], to: account.address, value: "0x2386f26fc10000" },
        ],
      })) as Hex;
      expect((await receiptFor(fundHash)).status).toBe("success");
      const deployment = encodeDeployData({
        abi: constructorAbi,
        bytecode,
        args: [account.address],
      });
      const deployHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: dev[0], data: deployment }],
      })) as Hex;
      const deployReceipt = await receiptFor(deployHash);
      expect(deployReceipt.status).toBe("success");
      const contract = deployReceipt.contractAddress!;
      expect(contract).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(await publicClient.getCode({ address: contract })).not.toBe("0x");
      expect(
        (
          await publicClient.readContract({
            address: contract,
            abi: signerAbi,
            functionName: "signer",
          })
        ).toLowerCase(),
      ).toBe(account.address.toLowerCase());
      expect(await publicClient.getChainId()).toBe(31337);
      console.info(
        "SM02: offline actual Solidity bytecode deployed; receipt/code/immutable signer verified",
      );
      phase = "evidence";

      const organization = await prisma.organization.create({
        data: { name: "Owned Anvil smoke", slug: "owned-anvil-smoke" },
      });
      const auth = createAuthService(prisma, "open");
      const actor = await auth.signUp({
        name: "Local actor",
        rut: "12.345.678-5",
        password: "local-smoke-password-123",
      });
      const { sessionToken } = await auth.login({
        rut: "12.345.678-5",
        password: "local-smoke-password-123",
      });
      const outsider = await auth.signUp({
        name: "Other local actor",
        rut: "12.345.679-3",
        password: "local-outsider-password-456",
      });
      const { sessionToken: outsiderSessionToken } = await auth.login({
        rut: "12.345.679-3",
        password: "local-outsider-password-456",
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
      const evidence = createEvidencePersistence(prisma);
      const makeBatch = async (label: string) => {
        const invoice = await prisma.invoice.create({
          data: {
            invoiceId: label,
            organizationId: organization.id,
            ownerType: "USER",
            ownerId: actor.id,
            createdByUserId: actor.id,
            vendorName: "Synthetic vendor",
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
        return evidence.createBatch(actor, context, [record.id]);
      };
      const batch = await makeBatch("SMOKE-1");
      const client = createEvidenceAnchorClient(
        {
          chainId: 31337,
          contractAddress: contract,
          signerAddress: account.address,
        },
        {
          ...createViemEvidenceAnchorTransport(31337, account, provider),
          getChainId: () => publicClient.getChainId(),
          getSignerAddress: async () => account.address,
          getContractSigner: (address) =>
            publicClient.readContract({
              address: address as Hex,
              abi: signerAbi,
              functionName: "signer",
            }),
          isRootRegistered: (address, root) =>
            publicClient.readContract({
              address: address as Hex,
              abi: readAbi,
              functionName: "isRootRegistered",
              args: [root as Hex],
            }),
        },
      );
      expect(await client.isRootRegistered(batch.rootHash)).toBe(false);
      console.info(
        "SM03: RULE_V1 evidence and batch reconstructed; root initially false",
      );
      phase = "full-cli-anchor";
      const ownedRelay = await createOwnedAnvilRelay({
        pid,
        port,
        observer,
        batchId: batch.id,
      });
      relay = ownedRelay;
      checkOwnedListener(pid, port);
      const cliAnchor = await runOwnedChild(
        "pnpm",
        [
          "exec",
          "tsx",
          "src/evidence-anchor-cli.ts",
          "anchor",
          "--batch-id",
          batch.id,
          "--organization-id",
          organization.id,
          "--owner-type",
          "user",
          "--owner-id",
          actor.id,
        ],
        {
          cwd: process.cwd(),
          timeoutMs: 60_000,
          maxOutputBytes: 64_000,
          env: {
            ...Object.fromEntries(
              ["PATH", "HOME", "TMPDIR"]
                .filter((key) => process.env[key])
                .map((key) => [key, process.env[key]]),
            ),
            DATABASE_URL: url,
            APP_SESSION_TOKEN: sessionToken,
            EVM_RPC_URL: ownedRelay.endpoint,
            EVM_CHAIN_ID: "31337",
            EVIDENCE_CONTRACT_ADDRESS: contract,
            EVM_SIGNER_PRIVATE_KEY: signerPrivateKey,
          },
        },
      );
      step = "full-cli-anchor-child";
      if (cliAnchor.spawnCode || cliAnchor.timedOut || cliAnchor.status !== 0) {
        const diagnostic = cliAnchor.stderr.match(
          /^EVIDENCE_ANCHOR_DIAGNOSTIC phase=(input|database|execute|cleanup) operation=(anchor|reconcile|command) reason=(usage|authentication|configuration|database|data|operation|cleanup) outcome=failed$/m,
        );
        const failure = new Error(
          formatSmokeFailure({
            step,
            cause: cliAnchor.timedOut
              ? "child-timeout"
              : cliAnchor.spawnCode
                ? "child-spawn-error"
                : Number.isSafeInteger(cliAnchor.status) &&
                    cliAnchor.status !== 0
                  ? "child-exit-nonzero"
                  : "child-process-failed",
            status: cliAnchor.status,
            signal: cliAnchor.signal,
            spawnCode: cliAnchor.spawnCode,
            cliPhase: diagnostic?.[1],
            cliOperation: diagnostic?.[2],
            cliReason: diagnostic?.[3],
            phase,
            method: rpc.getLastMethod(),
          }),
        );
        console.error(failure.message);
        throw failure;
      }
      step = "full-cli-anchor-output";
      const anchorOutput = JSON.parse(cliAnchor.stdout) as {
        action?: string;
        kind?: string;
      };
      expect(anchorOutput).toMatchObject({
        action: "anchor",
        kind: "broadcastedUnknown",
      });
      expect(cliAnchor.stdout).not.toContain(signerPrivateKey);
      expect(cliAnchor.stderr).not.toContain(signerPrivateKey);
      expect(cliAnchor.stdout).not.toContain(sessionToken);
      expect(cliAnchor.stderr).not.toContain(sessionToken);
      step = "anchor-assertions";
      const callsBeforeRejectedCli = ownedRelay.requestCount;
      const cliArgs = [
        "exec",
        "tsx",
        "src/evidence-anchor-cli.ts",
        "anchor",
        "--batch-id",
        batch.id,
        "--organization-id",
        organization.id,
        "--owner-type",
        "user",
        "--owner-id",
        actor.id,
      ];
      const rejectedCliEnvironment = (token: string) => ({
        ...Object.fromEntries(
          ["PATH", "HOME", "TMPDIR"]
            .filter((key) => process.env[key])
            .map((key) => [key, process.env[key]]),
        ),
        DATABASE_URL: url,
        APP_SESSION_TOKEN: token,
        EVM_RPC_URL: ownedRelay.endpoint,
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: contract,
        EVM_SIGNER_PRIVATE_KEY: signerPrivateKey,
      });
      const missingSessionCli = await runOwnedChild("pnpm", cliArgs, {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
        env: rejectedCliEnvironment("synthetic-invalid-session"),
      });
      expect(missingSessionCli.spawnCode).toBeUndefined();
      expect(missingSessionCli.timedOut).toBe(false);
      expect(missingSessionCli.outputLimitExceeded).toBe(false);
      expect(missingSessionCli.status).toBe(1);
      expect(missingSessionCli.stdout).toBe(
        JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }) + "\n",
      );
      expect(missingSessionCli.stdout).not.toContain(signerPrivateKey);
      const foreignSessionCli = await runOwnedChild("pnpm", cliArgs, {
        cwd: process.cwd(),
        timeoutMs: 30_000,
        maxOutputBytes: 64_000,
        env: rejectedCliEnvironment(outsiderSessionToken),
      });
      expect(foreignSessionCli.spawnCode).toBeUndefined();
      expect(foreignSessionCli.timedOut).toBe(false);
      expect(foreignSessionCli.outputLimitExceeded).toBe(false);
      expect(foreignSessionCli.status).toBe(1);
      expect(foreignSessionCli.stdout).toBe(
        JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }) + "\n",
      );
      expect(ownedRelay.requestCount).toBe(callsBeforeRejectedCli);
      expect(ownedRelay.rawSendCount).toBe(1);
      const expectedHash = ownedRelay.transactionHash;
      expect(expectedHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(rawSends).toBe(0);
      const cliPrepared =
        await observer.evidencePreparedAnchorTransaction.findFirstOrThrow({
          where: { reservation: { batchId: batch.id } },
        });
      expect(cliPrepared.nonce).toBe(0n);
      expect(
        `0x${Buffer.from(cliPrepared.transactionHash).toString("hex")}`,
      ).toBe(expectedHash);
      console.info(
        "SM04-CLI: actual CLI process committed its prepared transaction before one default-HTTP raw send through the owned relay",
      );
      phase = "reconcile";
      const receipt = await receiptFor(expectedHash!);
      expect(receipt.status).toBe("success");
      expect(receipt.logs).toHaveLength(1);
      expect(
        decodeEventLog({
          abi: rootRegisteredAbi,
          data: receipt.logs[0].data,
          topics: receipt.logs[0].topics,
        }),
      ).toMatchObject({
        eventName: "RootRegistered",
        args: { rootHash: batch.rootHash, signer: account.address },
      });
      expect(await client.isRootRegistered(batch.rootHash)).toBe(true);
      const reservation =
        await observer.evidenceAnchorReservation.findFirstOrThrow({
          where: { batchId: batch.id },
        });
      const observation = await createEvidenceAnchorReconciliation(
        createEvidenceAnchorObservations(prisma),
        createViemEvidenceAnchorReader(provider),
      ).check(actor, context, batch.id, reservation.id);
      expect(observation).toMatchObject({
        kind: "observedSuccess",
        reason: "matched",
        receiptStatus: "success",
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
      });
      const persisted =
        await observer.evidenceAnchorObservation.findFirstOrThrow({
          where: { reservationId: reservation.id },
        });
      expect(persisted.kind).toBe("observedSuccess");
      expect(Buffer.from(persisted.blockHash!)).toEqual(
        Buffer.from(receipt.blockHash.slice(2), "hex"),
      );
      expect(Buffer.from(persisted.transactionHash)).toEqual(
        Buffer.from(expectedHash!.slice(2), "hex"),
      );
      console.info(
        `SM05: receipt success, exact indexed event, root true, durable canonical observation block ${receipt.blockNumber}`,
      );

      phase = "full-cli-reconcile";
      checkOwnedListener(pid, port);
      step = "full-cli-reconcile-child";
      const cli = await runOwnedChild(
        "pnpm",
        [
          "exec",
          "tsx",
          "src/evidence-anchor-cli.ts",
          "reconcile",
          "--batch-id",
          batch.id,
          "--organization-id",
          organization.id,
          "--owner-type",
          "user",
          "--owner-id",
          actor.id,
          "--reservation-id",
          reservation.id,
        ],
        {
          cwd: process.cwd(),
          timeoutMs: 30_000,
          maxOutputBytes: 64_000,
          env: {
            ...Object.fromEntries(
              ["PATH", "HOME", "TMPDIR"]
                .filter((key) => process.env[key])
                .map((key) => [key, process.env[key]]),
            ),
            DATABASE_URL: url,
            APP_SESSION_TOKEN: sessionToken,
            EVM_RPC_URL: ownedRelay.endpoint,
            EVM_CHAIN_ID: "31337",
            EVIDENCE_CONTRACT_ADDRESS: contract,
          },
        },
      );
      if (cli.spawnCode || cli.timedOut || cli.status !== 0) {
        const diagnostic = cli.stderr.match(
          /^EVIDENCE_ANCHOR_DIAGNOSTIC phase=(input|database|execute|cleanup) operation=(anchor|reconcile|command) reason=(usage|authentication|configuration|database|data|operation|cleanup) outcome=failed$/m,
        );
        const failure = new Error(
          formatSmokeFailure({
            step,
            cause: cli.timedOut
              ? "child-timeout"
              : cli.spawnCode
                ? "child-spawn-error"
                : Number.isSafeInteger(cli.status) && cli.status !== 0
                  ? "child-exit-nonzero"
                  : "child-process-failed",
            status: cli.status,
            signal: cli.signal,
            spawnCode: cli.spawnCode,
            cliPhase: diagnostic?.[1],
            cliOperation: diagnostic?.[2],
            cliReason: diagnostic?.[3],
            phase,
            method: rpc.getLastMethod(),
          }),
        );
        console.error(failure.message);
        throw failure;
      }
      step = "full-cli-reconcile-output";
      const cliOutput = JSON.parse(cli.stdout) as {
        action?: string;
        kind?: string;
        reason?: string;
      };
      expect(cliOutput).toMatchObject({
        action: "reconcile",
        kind: "observedSuccess",
        reason: "matched",
      });
      expect(cli.stdout).not.toContain(sessionToken);
      expect(cli.stderr).not.toContain(sessionToken);
      expect(cli.stdout).not.toContain("EVM_SIGNER_PRIVATE_KEY");
      console.info(
        "SM05-CLI: actual tsx CLI process reconciled through the default loopback HTTP provider without signer configuration",
      );
      phase = "guards";
      step = "reconcile-assertions";
      const anchor = createEvidenceAnchor(
        { ...evidence, ...createEvidenceAnchorReservation(prisma) },
        client,
      );

      step = "guard-assertions";
      expect(await anchor.anchorBatch(actor, context, batch.id)).toBe(
        "alreadyRegistered",
      );
      const beforeForeign = rpc.getRequestCount();
      await expect(
        anchor.anchorBatch(outsider, context, batch.id),
      ).rejects.toThrow();
      expect(rpc.getRequestCount()).toBe(beforeForeign);
      const second = await makeBatch("SMOKE-2");
      expect(second.rootHash).not.toBe(batch.rootHash);
      await expect(
        anchor.anchorBatch(actor, context, second.id),
      ).rejects.toThrow("Signer preparation slot unavailable");
      expect(rawSends).toBe(0);
      expect(ownedRelay.rawSendCount).toBe(1);
      expect(
        await publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      ).toBe(1);
      expect(await observer.evidencePreparedAnchorTransaction.count()).toBe(1);
      console.info(
        "SM06: repeated registered batch, foreign authorization and second-root signer slot blocked; one raw send, nonce 1",
      );
    } catch (error) {
      const lastMethod = rpc.getLastMethod();
      if (
        !(error instanceof Error) ||
        !/^SMOKE_FAILURE step=[a-z0-9-]+ cause=[a-z0-9-]+ /.test(error.message)
      ) {
        reportSmokeFailure(error, {
          step,
          cause: "assertion-failed",
          phase,
          method: lastMethod,
        });
      }
      throw error;
    } finally {
      if (relay) await relay.close();
      await observer.$disconnect();
      await prisma.$disconnect();
    }
  });
});
