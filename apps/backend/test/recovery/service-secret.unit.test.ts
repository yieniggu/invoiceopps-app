import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertDistinctServiceSecrets,
  looksRandom,
  validatedServiceSecret,
} from "../../src/service-secret.js";

const hex = () => randomBytes(32).toString("hex");
const base64 = () => randomBytes(48).toString("base64url");

describe("service secret randomness (CR-512)", () => {
  it("accepts generated hex and base64url secrets", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(looksRandom(hex())).toBe(true);
      expect(looksRandom(base64())).toBe(true);
    }
    expect(validatedServiceSecret("X", hex())).toHaveLength(64);
  });

  it.each([
    ["a repeated character", "a".repeat(40)],
    ["a short hex cycle", "ab12".repeat(10)],
    ["a repeated word", "changeme".repeat(5)],
    ["a repeated digit run", "1234567890".repeat(4)],
    ["a low-entropy phrase", "passwordpasswordpasswordpassword"],
  ])("rejects %s without echoing it", (_label, value) => {
    expect(looksRandom(value)).toBe(false);
    let message = "";
    try {
      validatedServiceSecret("MODEL_API_SERVICE_TOKEN", value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/MODEL_API_SERVICE_TOKEN must be a randomly/);
    expect(message).not.toContain(value);
  });

  it("keeps the length and whitespace rules", () => {
    expect(() => validatedServiceSecret("X", "short")).toThrow(/32-512/);
    expect(() => validatedServiceSecret("X", `${hex()} `)).toThrow(/32-512/);
  });
});

describe("distinct service secrets (CR-512)", () => {
  it("accepts different values and ignores unset ones", () => {
    expect(() =>
      assertDistinctServiceSecrets({
        INTERNAL_INTROSPECTION_SECRET: hex(),
        MODEL_API_SERVICE_TOKEN: hex(),
        GATEWAY_SERVICE_READ_TOKEN: undefined,
      }),
    ).not.toThrow();
    expect(() =>
      assertDistinctServiceSecrets({ A: "", B: "  ", C: undefined }),
    ).not.toThrow();
  });

  it("rejects two identical values naming the variables, never the value", () => {
    const shared = hex();
    let message = "";
    try {
      assertDistinctServiceSecrets({
        INTERNAL_INTROSPECTION_SECRET: shared,
        MODEL_API_SERVICE_TOKEN: hex(),
        GATEWAY_SERVICE_READ_TOKEN: shared,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("INTERNAL_INTROSPECTION_SECRET");
    expect(message).toContain("GATEWAY_SERVICE_READ_TOKEN");
    expect(message).not.toContain(shared);
  });
});
