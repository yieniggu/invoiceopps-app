import { describe, expect, it } from "vitest";

import { trustProxyHopsFromEnv } from "../../src/http/trust-proxy.js";

describe("AUTH_TRUST_PROXY_HOPS parsing", () => {
  it.each([undefined, "", "   "])("keeps trust proxy off for %j", (value) => {
    expect(trustProxyHopsFromEnv(value)).toBeUndefined();
  });

  it.each([
    ["0", 0],
    ["1", 1],
    [" 2 ", 2],
    ["10", 10],
  ])("accepts %j as %i hops", (value, hops) => {
    expect(trustProxyHopsFromEnv(value)).toBe(hops);
  });

  it.each([
    "-1",
    "1.5",
    "abc",
    "1e3",
    "true",
    "0x1",
    "+1",
    "1 2",
    "9007199254740993",
  ])("aborts startup for the invalid value %j", (value) => {
    expect(() => trustProxyHopsFromEnv(value)).toThrow(
      "AUTH_TRUST_PROXY_HOPS must be a non-negative integer",
    );
  });
});
