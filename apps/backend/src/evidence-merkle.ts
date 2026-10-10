import { keccak_256 } from "@noble/hashes/sha3.js";

const HEX32 = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLICY = "invoice-merkle-v2";
const MAX_LEAVES = 256;

type Side = "left" | "right";
type Proof = Array<[Side, string]>;
type Item = {
  decisionEventId: string;
  leafHash: string;
  organizationId: string;
  ownerType: "user" | "group";
  ownerId: string;
};

function hex32(value: unknown): value is string {
  return typeof value === "string" && HEX32.test(value);
}

function decode(hash: string): Uint8Array {
  return Buffer.from(hash.slice(2), "hex");
}

export function hashEvidenceV2Bytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Evidence V2 hash input must be bytes");
  }
  return `0x${Buffer.from(keccak_256(bytes)).toString("hex")}`;
}

export function hashEvidenceV2Pair(left: string, right: string): string {
  if (!hex32(left) || !hex32(right)) {
    throw new Error("Invalid Evidence V2 Merkle hash");
  }
  return hashEvidenceV2Bytes(Buffer.concat([decode(left), decode(right)]));
}

function batchItem(value: unknown): Item {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Invalid Evidence V2 batch item");
  }
  const fields = [
    "decisionEventId",
    "leafHash",
    "organizationId",
    "ownerType",
    "ownerId",
  ];
  if (Reflect.ownKeys(value).length !== fields.length) {
    throw new Error("Invalid Evidence V2 batch item");
  }
  const item: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Invalid Evidence V2 batch item");
    }
    item[field] = descriptor.value;
  }
  if (
    typeof item.decisionEventId !== "string" ||
    !UUID.test(item.decisionEventId) ||
    typeof item.organizationId !== "string" ||
    !UUID.test(item.organizationId) ||
    typeof item.ownerId !== "string" ||
    !UUID.test(item.ownerId) ||
    (item.ownerType !== "user" && item.ownerType !== "group") ||
    !hex32(item.leafHash)
  ) {
    throw new Error("Invalid Evidence V2 batch item");
  }
  return {
    decisionEventId: item.decisionEventId,
    organizationId: item.organizationId,
    ownerId: item.ownerId,
    ownerType: item.ownerType,
    leafHash: item.leafHash,
  };
}

export function buildEvidenceBatchV2(input: unknown): {
  rootHash: string;
  leafCount: number;
  policyVersion: string;
  items: Array<Item & { leafIndex: number; proof: Proof }>;
} {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_LEAVES) {
    throw new Error("Evidence V2 batch requires 1 to 256 leaves");
  }
  const items = Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("Invalid Evidence V2 batch item");
    }
    return batchItem(descriptor.value);
  });
  const first = items[0];
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const item of items) {
    if (
      item.organizationId !== first.organizationId ||
      item.ownerType !== first.ownerType ||
      item.ownerId !== first.ownerId ||
      ids.has(item.decisionEventId) ||
      hashes.has(item.leafHash)
    ) {
      throw new Error(
        "Evidence V2 batch must have one owner and unique leaves",
      );
    }
    ids.add(item.decisionEventId);
    hashes.add(item.leafHash);
  }
  const sorted = items.sort((a, b) =>
    a.decisionEventId < b.decisionEventId
      ? -1
      : a.decisionEventId > b.decisionEventId
        ? 1
        : 0,
  );
  const levels: string[][] = [sorted.map((item) => item.leafHash)];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const parents: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      parents.push(
        hashEvidenceV2Pair(level[index], level[index + 1] ?? level[index]),
      );
    }
    levels.push(parents);
  }
  return {
    rootHash: levels.at(-1)![0],
    leafCount: sorted.length,
    policyVersion: POLICY,
    items: sorted.map((item, leafIndex) => {
      const proof: Proof = [];
      let index = leafIndex;
      for (const level of levels.slice(0, -1)) {
        proof.push([
          index % 2 === 0 ? "right" : "left",
          level[index ^ 1] ?? level[index],
        ]);
        index = Math.floor(index / 2);
      }
      return { ...item, leafIndex, proof };
    }),
  };
}

export function verifyEvidenceProofV2(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const input = value as Record<string, unknown>;
  const { leafHash, rootHash, leafIndex, leafCount, policyVersion, proof } =
    input;
  if (
    !hex32(leafHash) ||
    !hex32(rootHash) ||
    policyVersion !== POLICY ||
    !Number.isInteger(leafCount) ||
    typeof leafCount !== "number" ||
    leafCount < 1 ||
    leafCount > MAX_LEAVES ||
    !Number.isInteger(leafIndex) ||
    typeof leafIndex !== "number" ||
    leafIndex < 0 ||
    leafIndex >= leafCount ||
    !Array.isArray(proof) ||
    proof.length > 8
  ) {
    return false;
  }
  let current = leafHash;
  let index = leafIndex;
  let width = leafCount;
  let step = 0;
  while (width > 1) {
    const entry: unknown = proof[step++];
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [side, sibling] = entry;
    if (!hex32(sibling) || side !== (index % 2 === 0 ? "right" : "left")) {
      return false;
    }
    if (index === width - 1 && width % 2 === 1 && sibling !== current) {
      return false;
    }
    current =
      side === "left"
        ? hashEvidenceV2Pair(sibling, current)
        : hashEvidenceV2Pair(current, sibling);
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  return step === proof.length && current === rootHash;
}
