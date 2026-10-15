import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import type { AuthUser } from "../src/auth.js";
import {
  createEvidenceAnchorCommand,
  parseEvidenceAnchorCommand,
} from "../src/evidence-anchor-command.js";
import type { AnchorObservation } from "../src/evidence-anchor-reconciliation.js";
import type { ResourceContext } from "../src/resources.js";

const RESOURCE_CONTEXT = {
  organizationId: "org-1",
  ownerType: "user" as const,
  ownerId: "user-1",
};
const GROUP_CONTEXT = {
  organizationId: "org-1",
  ownerType: "group" as const,
  ownerId: "group-1",
};
const SESSION_TOKEN = "synthetic-session-token";
const RPC_URL = "https://rpc.example.invalid/path?token=synthetic-rpc-token";
const SIGNER_KEY = generatePrivateKey();
const SIGNER_ADDRESS = privateKeyToAccount(SIGNER_KEY).address;
const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const ROOT_HASH = `0x${"a".repeat(64)}`;
const TRANSACTION_HASH = `0x${"b".repeat(64)}` as Hex;

function commandLine(
  action: "anchor" | "reconcile" = "anchor",
  context: ResourceContext = RESOURCE_CONTEXT,
) {
  return [
    action,
    "--batch-id",
    "batch-1",
    "--organization-id",
    context.organizationId,
    "--owner-type",
    context.ownerType,
    "--owner-id",
    context.ownerId,
    ...(action === "reconcile" ? ["--reservation-id", "reservation-1"] : []),
  ];
}

function dependencies(
  options: {
    authenticateSession?: () => Promise<{
      id: string;
      name: string;
      rut: string;
      email: null;
      username: null;
      isPlatformAdministrator: boolean;
      memberships: [];
    }>;
    authorizeContext?: () => Promise<void>;
    isPlatformAdministrator?: boolean;
  } = {},
) {
  const events: string[] = [];
  return {
    authenticateSession: vi.fn(
      options.authenticateSession ??
        (async () => ({
          id: "user-1",
          name: "Trusted Session User",
          rut: "12.345.678-5",
          email: null,
          username: null,
          isPlatformAdministrator: options.isPlatformAdministrator ?? false,
          memberships: [],
        })),
    ),
    data: {
      authorizeContext: vi.fn(async () => {
        events.push("authorize");
        await options.authorizeContext?.();
      }),
      getBatch: vi.fn(async () => ({
        id: "batch-1",
        rootHash: ROOT_HASH,
        leafCount: 1,
        policyVersion: "invoice-merkle-v2",
      })),
      claimAnchorSubmission: vi.fn(async () => ({
        kind: "acquired" as const,
        reservationId: "reservation-1",
        claimToken: "synthetic-claim-token",
      })),
      acquireSignerPreparationSlot: vi.fn(async () => {}),
      persistPreparedTransaction: vi.fn(async () => {}),
      readPrepared: vi.fn(async () => ({
        reservationId: "reservation-1",
        chainId: 31337,
        signerAddress: SIGNER_ADDRESS,
        contractAddress: CONTRACT_ADDRESS,
        rootHash: ROOT_HASH,
        transactionHash: TRANSACTION_HASH,
        nonce: 7n,
        gas: 90_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      })),
      latest: vi.fn(async () => null),
      append: vi.fn(
        async (
          _actor: AuthUser,
          _context: ResourceContext,
          _batch: string,
          _reservation: string,
          observation: AnchorObservation,
        ) => observation,
      ),
    },
    createEvmRuntime: vi.fn(() => {
      events.push("runtime");
      return {
        transport: {
          getChainId: vi.fn(async () => 31337),
          getSignerAddress: vi.fn(async () => SIGNER_ADDRESS),
          getContractSigner: vi.fn(async () => SIGNER_ADDRESS),
          isRootRegistered: vi.fn(async () => true),
          getPendingNonce: vi.fn(async () => 7),
          prepareRootRegistration: vi.fn(async () => {
            throw new Error(
              "Already-registered fixture must not prepare a transaction",
            );
          }),
          broadcastSignedTransaction: vi.fn(async () => TRANSACTION_HASH),
        },
        chainReader: {
          getChainId: vi.fn(async () => 31337),
          getContractSigner: vi.fn(async () => SIGNER_ADDRESS),
          getTransaction: vi.fn(async () => null),
          getReceipt: vi.fn(async () => null),
          getCanonicalBlock: vi.fn(async () => ({ number: null, hash: null })),
        },
      };
    }),
    events,
  };
}

describe("parseEvidenceAnchorCommand", () => {
  it("parses an explicit anchor action with resource context", () => {
    expect(parseEvidenceAnchorCommand(commandLine("anchor"))).toEqual({
      action: "anchor",
      batchId: "batch-1",
      context: RESOURCE_CONTEXT,
    });
  });

  it("parses an explicit reconciliation action and reservation", () => {
    expect(parseEvidenceAnchorCommand(commandLine("reconcile"))).toEqual({
      action: "reconcile",
      batchId: "batch-1",
      reservationId: "reservation-1",
      context: RESOURCE_CONTEXT,
    });
  });

  it.each([
    ["--actor-id", "attacker"],
    ["--private-key", "synthetic-private-key-value"],
    ["--rpc-url", "https://user:pass@provider.invalid/token"],
    ["--session-token", "synthetic-session-token"],
  ])(
    "rejects forbidden argument %s without echoing its value",
    (flag, value) => {
      let thrown: unknown;
      try {
        parseEvidenceAnchorCommand([...commandLine(), flag, value]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).not.toContain(value);
      expect(String(thrown)).not.toContain("pass@provider.invalid");
    },
  );

  it("rejects missing or unknown actions rather than performing implicit work", () => {
    expect(() => parseEvidenceAnchorCommand([])).toThrow();
    expect(() => parseEvidenceAnchorCommand(["status"])).toThrow();
    expect(() =>
      parseEvidenceAnchorCommand(["unlock", "reservation-1"]),
    ).toThrow();
    expect(() => parseEvidenceAnchorCommand(["retry", "batch-1"])).toThrow();
  });
});

describe("createEvidenceAnchorCommand", () => {
  it("derives the actor from the validated session, authorizes data context before anchor lookup, and reports only an existing registration", async () => {
    const ports = dependencies();
    const command = createEvidenceAnchorCommand(ports);
    const result = await command.execute(commandLine(), {
      APP_SESSION_TOKEN: SESSION_TOKEN,
      EVM_RPC_URL: RPC_URL,
      EVM_CHAIN_ID: "31337",
      EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
      EVM_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    });

    expect(ports.authenticateSession).toHaveBeenCalledWith(SESSION_TOKEN);
    expect(ports.data.authorizeContext).toHaveBeenCalledWith(
      "user-1",
      RESOURCE_CONTEXT,
    );
    expect(ports.data.getBatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1", name: "Trusted Session User" }),
      RESOURCE_CONTEXT,
      "batch-1",
    );
    expect(result).toMatchObject({ kind: "alreadyRegistered" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain(SIGNER_KEY);
    expect(serialized).not.toContain(RPC_URL);
    expect(serialized).not.toContain("synthetic-rpc-token");
    expect(serialized).not.toContain("/path");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("pass@rpc.example.invalid");
  });

  it("rejects unauthenticated sessions before authorization or anchor side effects", async () => {
    const ports = dependencies({
      authenticateSession: async () => {
        throw new Error("Unauthorized");
      },
    });
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine(), { APP_SESSION_TOKEN: SESSION_TOKEN }),
    ).rejects.toThrow();
    expect(ports.data.authorizeContext).not.toHaveBeenCalled();
    expect(ports.data.getBatch).not.toHaveBeenCalled();
  });

  it("does not let platform-administrator status bypass resource ACL authorization", async () => {
    const ports = dependencies({
      isPlatformAdministrator: true,
      authorizeContext: async () => {
        throw new Error("Forbidden");
      },
    });
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine(), { APP_SESSION_TOKEN: SESSION_TOKEN }),
    ).rejects.toThrow();
    expect(ports.data.authorizeContext).toHaveBeenCalledWith(
      "user-1",
      RESOURCE_CONTEXT,
    );
    expect(ports.data.getBatch).not.toHaveBeenCalled();
  });

  it("preserves group membership ACL checks before accessing the EVM runtime", async () => {
    const ports = dependencies({
      authorizeContext: async () => {
        throw new Error("Forbidden");
      },
    });
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine("anchor", GROUP_CONTEXT), {
        APP_SESSION_TOKEN: SESSION_TOKEN,
      }),
    ).rejects.toThrow();
    expect(ports.data.authorizeContext).toHaveBeenCalledWith(
      "user-1",
      GROUP_CONTEXT,
    );
    expect(ports.createEvmRuntime).not.toHaveBeenCalled();
  });

  it("performs ACL checks before any EVM runtime access", async () => {
    const ports = dependencies({
      authorizeContext: async () => {
        throw new Error("Forbidden");
      },
    });
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine(), { APP_SESSION_TOKEN: SESSION_TOKEN }),
    ).rejects.toThrow();
    expect(ports.events).toEqual(["authorize"]);
    expect(ports.createEvmRuntime).not.toHaveBeenCalled();
  });

  it("reconciles using persisted reservation identity and only returns a provisional observation", async () => {
    const ports = dependencies();
    const command = createEvidenceAnchorCommand(ports);
    const result = await command.execute(commandLine("reconcile"), {
      APP_SESSION_TOKEN: SESSION_TOKEN,
      EVM_RPC_URL: RPC_URL,
      EVM_CHAIN_ID: "31337",
      EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
    });

    expect(ports.data.readPrepared).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user-1" }),
      RESOURCE_CONTEXT,
      "batch-1",
      "reservation-1",
    );
    expect(result).toMatchObject({
      kind: "pending",
      reason: "transactionMissing",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain(SIGNER_KEY);
    expect(serialized).not.toContain(RPC_URL);
    expect(serialized).not.toContain("synthetic-rpc-token");
    expect(serialized).not.toContain("/path");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("pass@rpc.example.invalid");
  });

  it("does not read signer configuration or access a signer during reconciliation", async () => {
    const ports = dependencies();
    const environment = new Proxy(
      {
        APP_SESSION_TOKEN: SESSION_TOKEN,
        EVM_RPC_URL: "https://rpc.example.invalid",
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
      },
      {
        get(target, property, receiver) {
          if (property === "EVM_SIGNER_PRIVATE_KEY") {
            throw new Error("Signer configuration must not be read");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine("reconcile"), environment),
    ).resolves.toMatchObject({ kind: "pending" });
    expect(ports.data.readPrepared).toHaveBeenCalledOnce();
  });

  it("rejects a reconciliation target mismatch before constructing the EVM runtime", async () => {
    const ports = dependencies();
    ports.data.readPrepared.mockResolvedValue({
      reservationId: "reservation-1",
      chainId: 1,
      signerAddress: SIGNER_ADDRESS,
      contractAddress: CONTRACT_ADDRESS,
      rootHash: ROOT_HASH,
      transactionHash: TRANSACTION_HASH,
      nonce: 7n,
      gas: 90_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const command = createEvidenceAnchorCommand(ports);

    await expect(
      command.execute(commandLine("reconcile"), {
        APP_SESSION_TOKEN: SESSION_TOKEN,
        EVM_RPC_URL: RPC_URL,
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
      }),
    ).rejects.toThrow(
      "Evidence anchor target does not match prepared transaction",
    );
    expect(ports.createEvmRuntime).not.toHaveBeenCalled();
  });
});
