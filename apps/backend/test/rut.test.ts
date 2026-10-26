import { describe, expect, it } from "vitest";

import { formatRut, isValidRut, parseRut, RutError } from "../src/rut.js";

const VALID: Array<[string, string]> = [
  ["19034790-7", "190347907"],
  ["11111111-1", "111111111"],
  ["12345678-5", "123456785"],
  ["12345670-K", "12345670K"],
  // 7-digit bodies, K and 0 verification digits.
  ["1234567-4", "12345674"],
  ["1000005-K", "1000005K"],
  ["1000013-0", "10000130"],
  ["10000004-0", "100000040"],
];

// Keep identical to INVALID_LEADING_ZERO in apps/frontend/src/lib/rut.test.ts.
const INVALID_LEADING_ZERO = [
  "01234567-4",
  "00000000-0",
  "0.123.456-7",
  "012345674",
  "01.234.567-4",
];

describe("RUT module", () => {
  it.each(VALID)("round-trips %s", (api, canonical) => {
    expect(parseRut(api)).toBe(canonical);
    expect(formatRut(canonical)).toBe(api);
  });

  it("accepts dotted, dashed, bare, padded and lowercase k inputs", () => {
    expect(parseRut("19.034.790-7")).toBe("190347907");
    expect(parseRut("19034790-7")).toBe("190347907");
    expect(parseRut("190347907")).toBe("190347907");
    expect(parseRut(" 12345670-k ")).toBe("12345670K");
    expect(parseRut("1.234.567-4")).toBe("12345674");
  });

  it("accepts bare 9-digit input and normalizes a DV of 0", () => {
    expect(parseRut("100000040")).toBe("100000040");
    expect(parseRut("10.000.004-0")).toBe("100000040");
    expect(formatRut("100000040")).toBe("10000004-0");
  });

  it.each(INVALID_LEADING_ZERO)("rejects leading-zero body %j", (input) => {
    expect(() => parseRut(input)).toThrow(RutError);
    expect(() => parseRut(input)).toThrow("RUT must contain");
    expect(isValidRut(input)).toBe(false);
  });

  it.each([
    ["12345678-4", "RUT verification digit is invalid"],
    ["", "RUT must contain"],
    ["1234567", "RUT must contain"],
    ["123456789012", "RUT must contain"],
    ["12.34a.678-5", "RUT must contain"],
    ["x12345678-5", "RUT must contain"],
    ["12345678-5x", "RUT must contain"],
    ["12 345 678-5", "RUT must contain"],
    ["12.3456.78-5", "RUT must contain"],
    ["12345678-KK", "RUT must contain"],
  ])("rejects %j", (input, message) => {
    expect(() => parseRut(input)).toThrow(RutError);
    expect(() => parseRut(input)).toThrow(message);
    expect(isValidRut(input)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(() => parseRut(190347907)).toThrow(RutError);
    expect(isValidRut(null)).toBe(false);
    expect(isValidRut(undefined)).toBe(false);
  });

  it("validates good RUTs", () => {
    for (const [api] of VALID) expect(isValidRut(api)).toBe(true);
  });
});
