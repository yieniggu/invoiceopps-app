import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { readEvidenceAnchorConfig } from "../src/evidence-anchor-config.js";

const CONTRACT_ADDRESS = "0x1111111111111111111111111111111111111111";
const SIGNER_KEY = generatePrivateKey();

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    EVM_RPC_URL: "https://rpc.example.invalid/path?token=synthetic",
    EVM_CHAIN_ID: "31337",
    EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
    EVM_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    ...overrides,
  };
}

describe("readEvidenceAnchorConfig", () => {
  it("treats a fully absent anchor configuration as unavailable", () => {
    expect(
      readEvidenceAnchorConfig(
        {
          EVM_RPC_URL: undefined,
          EVM_CHAIN_ID: undefined,
          EVIDENCE_CONTRACT_ADDRESS: undefined,
          EVM_SIGNER_PRIVATE_KEY: undefined,
        },
        "anchor",
      ),
    ).toEqual({ kind: "unavailable" });
  });

  it("rejects each of the 14 incomplete nonempty anchor configurations without exposing supplied values", () => {
    const configuredValues = {
      EVM_RPC_URL: "https://rpc.example.invalid/path?token=synthetic",
      EVM_CHAIN_ID: "31337",
      EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
      EVM_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    };
    const entries = Object.entries(configuredValues);

    for (let mask = 1; mask < 15; mask += 1) {
      const partial = Object.fromEntries(
        entries.filter((_, index) => (mask & (1 << index)) !== 0),
      );
      const supplied = {
        EVM_RPC_URL: undefined,
        EVM_CHAIN_ID: undefined,
        EVIDENCE_CONTRACT_ADDRESS: undefined,
        EVM_SIGNER_PRIVATE_KEY: undefined,
        ...partial,
      };
      let thrown: unknown;
      try {
        readEvidenceAnchorConfig(supplied, "anchor");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = String(thrown);
      for (const value of Object.values(supplied)) {
        if (value !== undefined) expect(message).not.toContain(value);
      }
    }
  });

  it("validates complete configuration and does not serialize the raw signer key", () => {
    const config = readEvidenceAnchorConfig(environment(), "anchor");

    expect(config.kind).toBe("configured");
    if (config.kind !== "configured") return;
    expect(config.target).toEqual({
      rpcUrl: "https://rpc.example.invalid/path?token=synthetic",
      chainId: 31337,
      contractAddress: CONTRACT_ADDRESS.toLowerCase(),
    });
    expect(config.signerAddress).toMatch(/^0x[0-9a-f]{40}$/i);
    expect(JSON.stringify(config)).not.toContain(SIGNER_KEY);
  });

  it.each([
    ["zero chain id", { EVM_CHAIN_ID: "0" }],
    ["non-decimal chain id", { EVM_CHAIN_ID: "31.337" }],
    ["unsafe chain id", { EVM_CHAIN_ID: "9007199254740992" }],
    ["malformed contract address", { EVIDENCE_CONTRACT_ADDRESS: "0x1234" }],
    [
      "zero contract address",
      { EVIDENCE_CONTRACT_ADDRESS: `0x${"0".repeat(40)}` },
    ],
    ["non-http remote URL", { EVM_RPC_URL: "file:///tmp/provider" }],
    [
      "URL credentials",
      { EVM_RPC_URL: "https://user:pass@rpc.example.invalid" },
    ],
    [
      "invalid private-key scalar",
      { EVM_SIGNER_PRIVATE_KEY: `0x${"f".repeat(64)}` },
    ],
  ])(
    "rejects %s without including configuration values in the error",
    (_label, override) => {
      const supplied = environment(override);

      let thrown: unknown;
      try {
        readEvidenceAnchorConfig(supplied, "anchor");
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = String(thrown);
      for (const value of Object.values(supplied)) {
        if (value !== undefined) expect(message).not.toContain(value);
      }
      expect(message).not.toContain("user:pass");
      expect(message).not.toContain("synthetic");
    },
  );

  it.each([
    ["STACK-04 loopback endpoint", "http://127.0.0.1:8545"],
    ["STACK-04 IPv6 loopback endpoint", "http://[::1]:8545"],
  ])("allows %s: %s", (_label, rpcUrl) => {
    expect(
      readEvidenceAnchorConfig(environment({ EVM_RPC_URL: rpcUrl }), "anchor")
        .kind,
    ).toBe("configured");
  });

  it.each(["31336", "31338"])(
    "rejects IPv4 and IPv6 Stack local RPCs configured with chain ID %s",
    (chainId) => {
      for (const rpcUrl of ["http://127.0.0.1:18545", "http://[::1]:18545"]) {
        expect(() =>
          readEvidenceAnchorConfig(
            environment({ EVM_RPC_URL: rpcUrl, EVM_CHAIN_ID: chainId }),
            "anchor",
          ),
        ).toThrow();
      }
    },
  );

  it("preserves configured remote targets outside the STACK-04 local profile", () => {
    expect(
      readEvidenceAnchorConfig(
        environment({
          EVM_RPC_URL: "https://rpc.example.invalid",
          EVM_CHAIN_ID: "10200",
        }),
        "anchor",
      ).kind,
    ).toBe("configured");
  });

  it.each([
    "http://localhost:8545",
    "http://127.0.0.2:8545",
    "http://provider.example.invalid",
  ])(
    "rejects HTTP endpoint outside the approved literal-loopback allowlist: %s",
    (rpcUrl) => {
      expect(() =>
        readEvidenceAnchorConfig(
          environment({ EVM_RPC_URL: rpcUrl }),
          "anchor",
        ),
      ).toThrow();
    },
  );

  it("does not access or require signer configuration for reconciliation", () => {
    const values: Record<string, string | undefined> = {
      EVM_RPC_URL: "https://rpc.example.invalid",
      EVM_CHAIN_ID: "31337",
      EVIDENCE_CONTRACT_ADDRESS: CONTRACT_ADDRESS,
    };
    const reader = new Proxy(values, {
      get(target, property, receiver) {
        if (property === "EVM_SIGNER_PRIVATE_KEY") {
          throw new Error("Signer key must not be read");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(readEvidenceAnchorConfig(reader, "reconcile")).toEqual({
      kind: "configured",
      target: {
        rpcUrl: "https://rpc.example.invalid",
        chainId: 31337,
        contractAddress: CONTRACT_ADDRESS.toLowerCase(),
      },
    });
  });
});
