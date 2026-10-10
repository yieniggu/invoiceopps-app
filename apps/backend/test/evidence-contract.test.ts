import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as evidence from "../src/evidence.js";

type Proof = Array<["left" | "right", string]>;
type Vectors = {
  provenance: { emptyKeccak: string };
  fallback: {
    event: Record<string, unknown>;
    context: Record<string, unknown>;
    canonical: string;
    leafHash: string;
  };
  threeLeaf: {
    ids: string[];
    leaves: string[];
    parent01: string;
    parent22: string;
    root: string;
    firstProof: Proof;
    lastProof: Proof;
  };
};

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/evidence-v2-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

// The module exists, but these exports do not. Fail inside each executed test;
// never substitute a test implementation or accept a module collection failure.
function requirePureExport(name: string): (...args: unknown[]) => unknown {
  const exported: unknown = Reflect.get(evidence, name);
  if (typeof exported !== "function") {
    expect.fail(`APP-10 pure ${name} implementation is missing`);
  }
  return exported as (...args: unknown[]) => unknown;
}

function fallbackInput() {
  return {
    event: { ...vectors.fallback.event },
    context: { ...vectors.fallback.context },
  };
}

function payload() {
  return (
    JSON.parse(vectors.fallback.canonical) as {
      evidence: Record<string, unknown>;
    }
  ).evidence;
}

function batchItems() {
  return vectors.threeLeaf.ids.map((decisionEventId, index) => ({
    decisionEventId,
    leafHash: vectors.threeLeaf.leaves[index],
    organizationId: vectors.fallback.context.organizationId,
    ownerType: "group",
    ownerId: vectors.fallback.context.ownerId,
  }));
}

function proofInput(index: number, proof: Proof) {
  return {
    leafHash: vectors.threeLeaf.leaves[index],
    rootHash: vectors.threeLeaf.root,
    leafIndex: index,
    leafCount: 3,
    policyVersion: "invoice-merkle-v2",
    proof,
  };
}

describe("APP-10 Evidence V2 proposed pure contract", () => {
  it("retains the independent ASCII fallback bytes under the existing generic serializer", () => {
    const wrapper = JSON.parse(vectors.fallback.canonical) as unknown;
    expect(evidence.canonicalizeEvidenceValue(wrapper)).toEqual(
      Buffer.from(vectors.fallback.canonical, "utf8"),
    );
  });

  it("maps the fallback event into the exact versioned bytes without actor PII", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const encode = requirePureExport("canonicalizeEvidenceV2");
    expect(encode(build(fallbackInput()))).toEqual(
      Buffer.from(vectors.fallback.canonical, "utf8"),
    );
  });

  it("normalizes stored decimal strings without using JavaScript floats", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const result = build(fallbackInput());
    expect(result).toMatchObject({
      manual_review_threshold: "0.8",
      policy_probability: null,
      model_id: null,
      model_version: null,
      model_run_id: null,
    });
  });

  it("keeps Rule v1 lineage, recommendation, policy and threshold explicitly null", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const input = fallbackInput();
    Object.assign(input.event, {
      mode: "RULE_V1",
      ruleVersion: "invoice-rules-v1",
      policyVersion: null,
      manualReviewThreshold: null,
      policyProbabilitySource: null,
      recommendation: null,
    });
    expect(build(input)).toMatchObject({
      mode: "RULE_V1",
      rule_version: "invoice-rules-v1",
      policy_version: null,
      manual_review_threshold: null,
      policy_probability_source: null,
      model_id: null,
      model_version: null,
      model_run_id: null,
      recommendation: null,
    });
  });

  it("preserves LOCAL_DEMONSTRATION probability without inventing model lineage", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const input = fallbackInput();
    Object.assign(input.event, {
      policyProbabilitySource: "LOCAL_DEMONSTRATION",
      policyProbability: "0.5000",
      recommendation: null,
    });
    expect(build(input)).toMatchObject({
      policy_probability: "0.5",
      policy_probability_source: "LOCAL_DEMONSTRATION",
      model_id: null,
      model_version: null,
      model_run_id: null,
      recommendation: null,
    });
  });

  it("uses only persisted MODEL_API lineage and probability", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const input = fallbackInput();
    Object.assign(input.event, {
      policyProbabilitySource: "MODEL_API",
      policyProbability: "0.4000",
      modelId: "invoice-review",
      modelVersion: "7",
      modelRunId: "run-123",
      recommendation: "AUTO_PROCESS",
      decision: "AUTO_PROCESS",
    });
    expect(build(input)).toMatchObject({
      model_id: "invoice-review",
      model_version: "7",
      model_run_id: "run-123",
      policy_probability: "0.4",
      recommendation: "AUTO_PROCESS",
    });
  });

  it.each([
    { event: { manualReviewThreshold: "1e-7" }, expected: "0.0000001" },
    { event: { manualReviewThreshold: "0.0000" }, expected: "0" },
  ])(
    "renders finite persisted decimals in plain normalized notation",
    ({ event, expected }) => {
      const build = requirePureExport("buildEvidenceV2Payload");
      const input = fallbackInput();
      Object.assign(input.event, event);
      expect(build(input)).toMatchObject({ manual_review_threshold: expected });
    },
  );

  it.each(["NaN", "1.0001", "-0.1", 0.8])(
    "rejects invalid decimal input %s instead of coercing it",
    (invalid) => {
      const build = requirePureExport("buildEvidenceV2Payload");
      const input = fallbackInput();
      input.event.manualReviewThreshold = invalid;
      expect(() => build(input)).toThrow();
    },
  );

  it.each(["bad", "", null])("rejects an invalid owner UUID %s", (ownerId) => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const input = fallbackInput();
    input.context.ownerId = ownerId;
    expect(() => build(input)).toThrow();
  });

  it("rejects invalid mode and inconsistent MODEL_API_FALLBACK lineage", () => {
    const build = requirePureExport("buildEvidenceV2Payload");
    const invalidMode = fallbackInput();
    invalidMode.event.mode = "OTHER";
    expect(() => build(invalidMode)).toThrow();
    const inventedRun = fallbackInput();
    inventedRun.event.modelRunId = "made-up";
    expect(() => build(inventedRun)).toThrow();
  });

  it("rejects missing or extra evidence keys and mismatched enums", () => {
    const encode = requirePureExport("canonicalizeEvidenceV2");
    const missing = payload();
    delete missing.model_run_id;
    expect(() => encode(missing)).toThrow();
    expect(() => encode({ ...payload(), extra: "not-in-contract" })).toThrow();
    expect(() => encode({ ...payload(), owner_type: "other" })).toThrow();
  });

  it("rejects unsupported timestamps rather than inventing evaluation time", () => {
    const encode = requirePureExport("canonicalizeEvidenceV2");
    expect(() =>
      encode({ ...payload(), evaluated_at: "2026-10-07" }),
    ).toThrow();
  });

  it("rejects noncanonical decimal spellings when given a payload directly", () => {
    const encode = requirePureExport("canonicalizeEvidenceV2");
    expect(() =>
      encode({ ...payload(), manual_review_threshold: "0.8000" }),
    ).toThrow();
  });

  it("matches the independently known Ethereum Keccak empty-input vector", () => {
    const hash = requirePureExport("hashEvidenceV2Bytes");
    expect(hash(new Uint8Array())).toBe(vectors.provenance.emptyKeccak);
  });

  it("hashes exact canonical bytes to the independent fixture leaf", () => {
    const hash = requirePureExport("hashEvidenceV2Bytes");
    expect(hash(Buffer.from(vectors.fallback.canonical, "utf8"))).toBe(
      vectors.fallback.leafHash,
    );
  });

  it("changes the leaf when canonical bytes are altered", () => {
    const hash = requirePureExport("hashEvidenceV2Bytes");
    expect(
      hash(Buffer.from(`${vectors.fallback.canonical} `, "utf8")),
    ).not.toBe(vectors.fallback.leafHash);
  });

  it("rejects an empty batch and returns a single leaf as its root with empty proof", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    expect(() => batch([])).toThrow();
    expect(batch([batchItems()[0]])).toMatchObject({
      rootHash: vectors.threeLeaf.leaves[0],
      leafCount: 1,
      policyVersion: "invoice-merkle-v2",
      items: [{ leafIndex: 0, proof: [] }],
    });
  });

  it("sorts event UUIDs, pairs raw bytes positionally and duplicates an odd last leaf", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    expect(batch(batchItems().reverse())).toMatchObject({
      rootHash: vectors.threeLeaf.root,
      leafCount: 3,
      policyVersion: "invoice-merkle-v2",
      items: [
        {
          decisionEventId: vectors.threeLeaf.ids[0],
          leafIndex: 0,
          proof: vectors.threeLeaf.firstProof,
        },
        { decisionEventId: vectors.threeLeaf.ids[1], leafIndex: 1 },
        {
          decisionEventId: vectors.threeLeaf.ids[2],
          leafIndex: 2,
          proof: vectors.threeLeaf.lastProof,
        },
      ],
    });
  });

  it("matches independent literal parent hashes instead of hashing hex text", () => {
    const hashPair = requirePureExport("hashEvidenceV2Pair");
    expect(
      hashPair(vectors.threeLeaf.leaves[0], vectors.threeLeaf.leaves[1]),
    ).toBe(vectors.threeLeaf.parent01);
    expect(
      hashPair(vectors.threeLeaf.leaves[2], vectors.threeLeaf.leaves[2]),
    ).toBe(vectors.threeLeaf.parent22);
  });

  it("accepts 256 distinct leaves but rejects 257", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    const items = Array.from({ length: 257 }, (_, index) => {
      const hash = Buffer.alloc(32);
      hash.writeUInt32BE(index + 1, 28);
      return {
        ...batchItems()[0],
        decisionEventId: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        leafHash: `0x${hash.toString("hex")}`,
      };
    });
    expect(batch(items.slice(0, 256))).toMatchObject({ leafCount: 256 });
    expect(() => batch(items)).toThrow();
  });

  it("rejects duplicate event IDs and duplicate leaf hashes", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    const items = batchItems();
    expect(() => batch([items[0], items[0]])).toThrow();
    expect(() =>
      batch([items[0], { ...items[1], leafHash: items[0].leafHash }]),
    ).toThrow();
  });

  it("rejects another owner or organization and malformed leaf hex", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    const items = batchItems();
    expect(() =>
      batch([items[0], { ...items[1], ownerId: vectors.threeLeaf.ids[1] }]),
    ).toThrow();
    expect(() =>
      batch([
        items[0],
        { ...items[1], organizationId: vectors.threeLeaf.ids[1] },
      ]),
    ).toThrow();
    expect(() => batch([{ ...items[0], leafHash: "0x1234" }])).toThrow();
  });

  it("rejects sparse batch items and accessor properties without invoking them", () => {
    const batch = requirePureExport("buildEvidenceBatchV2");
    const sparse = new Array<unknown>(2);
    sparse[0] = batchItems()[0];
    expect(() => batch(sparse)).toThrow();
    const item = batchItems()[0];
    const getter = () => {
      throw new Error("Accessor must not run");
    };
    Object.defineProperty(item, "leafHash", { get: getter });
    expect(() => batch([item])).toThrow("Invalid Evidence V2 batch item");
  });

  it("verifies both independent oriented proofs against index and count", () => {
    const verify = requirePureExport("verifyEvidenceProofV2");
    expect(verify(proofInput(0, vectors.threeLeaf.firstProof))).toBe(true);
    expect(verify(proofInput(2, vectors.threeLeaf.lastProof))).toBe(true);
  });

  it("rejects tampered siblings, orientation, index, count and extra proof steps", () => {
    const verify = requirePureExport("verifyEvidenceProofV2");
    const proof = vectors.threeLeaf.lastProof;
    expect(
      verify(proofInput(2, [["right", vectors.threeLeaf.leaves[0]], proof[1]])),
    ).toBe(false);
    expect(verify(proofInput(2, [["left", proof[0][1]], proof[1]]))).toBe(
      false,
    );
    expect(verify({ ...proofInput(2, proof), leafIndex: 1 })).toBe(false);
    expect(verify({ ...proofInput(2, proof), leafCount: 2 })).toBe(false);
    expect(verify(proofInput(2, [...proof, proof[0]]))).toBe(false);
  });

  it("rejects malformed hashes, an invalid policy and a missing proof step", () => {
    const verify = requirePureExport("verifyEvidenceProofV2");
    const valid = proofInput(0, vectors.threeLeaf.firstProof);
    expect(verify({ ...valid, rootHash: "0x1234" })).toBe(false);
    expect(verify({ ...valid, leafHash: valid.leafHash.toUpperCase() })).toBe(
      false,
    );
    expect(verify({ ...valid, policyVersion: "invoice-merkle-v1" })).toBe(
      false,
    );
    expect(verify({ ...valid, proof: valid.proof.slice(0, 1) })).toBe(false);
  });
});
