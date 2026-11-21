import type { Response } from "express";
import { describe, expect, it } from "vitest";

import { internalServiceSecretFromEnv } from "../../src/features/api-tokens/introspection.js";
import {
  clearSessionCookie,
  sessionTokenFromCookie,
  setSessionCookie,
} from "../../src/features/auth/session.js";

// Generated once for these tests (hex, as `openssl rand -hex` makes them).
const RANDOM_32 = "5d0c8f1a7b3e9246c1e7a05f8d2b4963";
// 512 hex characters from a fixed-seed generator (no short repeating block).
const RANDOM_512 = (() => {
  let state = 0x2545f491;
  let out = "";
  while (out.length < 512) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += (state >>> 24).toString(16).padStart(2, "0");
  }
  return out.slice(0, 512);
})();

describe("INTERNAL_INTROSPECTION_SECRET startup validation (MLOPS-02)", () => {
  it("keeps the fail-closed mode when unset or empty", () => {
    expect(internalServiceSecretFromEnv(undefined)).toBeUndefined();
    expect(internalServiceSecretFromEnv("")).toBeUndefined();
  });

  it("accepts 32 to 512 random characters without whitespace", () => {
    expect(internalServiceSecretFromEnv(RANDOM_32)).toBe(RANDOM_32);
    expect(internalServiceSecretFromEnv(RANDOM_512)).toHaveLength(512);
  });

  it.each([
    ["too short", RANDOM_32.slice(0, 31)],
    ["too long", `${RANDOM_512}a`],
    ["with a space", `${RANDOM_32.slice(0, 20)} ${RANDOM_32.slice(20)}`],
    ["with a newline", `${RANDOM_32}\n`],
    ["with a tab", `${RANDOM_32}\t`],
    ["blank but not empty", " ".repeat(40)],
  ])("refuses to start with a secret that is %s", (_label, value) => {
    expect(() => internalServiceSecretFromEnv(value)).toThrow(
      /INTERNAL_INTROSPECTION_SECRET must be 32-512/,
    );
  });

  it("never echoes the secret in the error", () => {
    const value = `${"s3cret".repeat(3)} x`;
    try {
      internalServiceSecretFromEnv(value);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cret");
    }
  });

  it.each([
    ["a repeated character", "a".repeat(40)],
    ["a repeated word", "changeme".repeat(5)],
  ])(
    "refuses a secret that is %s (not randomly generated)",
    (_label, value) => {
      expect(() => internalServiceSecretFromEnv(value)).toThrow(
        /INTERNAL_INTROSPECTION_SECRET must be a randomly generated value/,
      );
    },
  );
});

describe("session cookie attributes (host-only, CR-513)", () => {
  function recorder() {
    const calls: Array<{ op: string; options: Record<string, unknown> }> = [];
    const response = {
      cookie: (_n: string, _v: string, options: Record<string, unknown>) =>
        calls.push({ op: "set", options }),
      clearCookie: (_n: string, options: Record<string, unknown>) =>
        calls.push({ op: "clear", options }),
    } as unknown as Response;
    return { calls, response };
  }

  it("never sets a Domain attribute: the cookie stays host-only", () => {
    const { calls, response } = recorder();
    setSessionCookie(response, "token");
    clearSessionCookie(response);
    expect(calls.map((c) => c.op)).toEqual(["set", "clear"]);
    for (const call of calls) expect(call.options).not.toHaveProperty("domain");
    expect(calls[0]?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });
});

describe("duplicate session cookies (documented in the README)", () => {
  it("treats a request with more than one session cookie as having none", () => {
    expect(sessionTokenFromCookie("invoiceops_session=a")).toBe("a");
    expect(
      sessionTokenFromCookie("invoiceops_session=a; invoiceops_session=b"),
    ).toBeUndefined();
    expect(sessionTokenFromCookie("other=1; invoiceops_session=a; x=2")).toBe(
      "a",
    );
  });
});
