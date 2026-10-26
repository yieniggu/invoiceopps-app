import { describe, expect, it } from "vitest";

import {
  cleanRut,
  formatRutInput,
  fromApiRut,
  isValidRut,
  nextRutInputValue,
  toApiRut,
} from "./rut";

const VALID: Array<[string, string]> = [
  ["19034790-7", "19.034.790-7"],
  ["11111111-1", "11.111.111-1"],
  ["12345678-5", "12.345.678-5"],
  ["12345670-K", "12.345.670-K"],
  // 7-digit bodies, K and 0 verification digits.
  ["1234567-4", "1.234.567-4"],
  ["1000005-K", "1.000.005-K"],
  ["1000013-0", "1.000.013-0"],
  ["10000004-0", "10.000.004-0"],
];

// Keep identical to INVALID_LEADING_ZERO in apps/backend/test/rut.test.ts.
const INVALID_LEADING_ZERO = [
  "01234567-4",
  "00000000-0",
  "0.123.456-7",
  "012345674",
  "01.234.567-4",
];

describe("frontend RUT helpers", () => {
  it("cleans to digits and uppercase K", () => {
    expect(cleanRut(" 12.345.670-k ")).toBe("12345670K");
    expect(cleanRut("ab1c2")).toBe("12");
  });

  it("formats progressively while typing", () => {
    expect(formatRutInput("")).toBe("");
    expect(formatRutInput("1")).toBe("1");
    expect(formatRutInput("1903")).toBe("190-3");
    expect(formatRutInput("190347907")).toBe("19.034.790-7");
    expect(formatRutInput("1903479078888")).toBe("19.034.790-7");
    expect(formatRutInput("12k45")).toBe("124-5");
  });

  it("deletes a trailing separator character instead of re-adding it", () => {
    expect(nextRutInputValue("19.034.790-7", "19.034.790")).toBe("1.903.479-0");
    expect(nextRutInputValue("190-3", "1903")).toBe("19-0");
    expect(nextRutInputValue("19.034.790-7", "19.034.7907")).toBe(
      "1.903.479-0",
    );
    expect(nextRutInputValue("19.034.790-7", "19.034.790-")).toBe(
      "1.903.479-0",
    );
  });

  it.each(VALID)("validates and converts %s", (api, display) => {
    expect(isValidRut(api)).toBe(true);
    expect(isValidRut(display)).toBe(true);
    expect(toApiRut(display)).toBe(api);
    expect(fromApiRut(api)).toBe(display);
    expect(fromApiRut(api.replace("-", ""))).toBe(display);
  });

  it("accepts bare 9-digit input", () => {
    expect(isValidRut("190347907")).toBe(true);
    expect(isValidRut("100000040")).toBe(true);
    expect(toApiRut("100000040")).toBe("10000004-0");
  });

  it.each(INVALID_LEADING_ZERO)("rejects leading-zero body %j", (input) => {
    expect(isValidRut(input)).toBe(false);
  });

  it("drops leading zeros while typing instead of keeping them", () => {
    expect(formatRutInput("0")).toBe("");
    expect(formatRutInput("00000000")).toBe("");
    expect(formatRutInput("012345674")).toBe("1.234.567-4");
    expect(formatRutInput("0.123.456-7")).toBe("123.456-7");
    expect(formatRutInput("1000013-0")).toBe("1.000.013-0");
    expect(nextRutInputValue("", "0")).toBe("");
  });

  it("rejects invalid RUTs", () => {
    expect(isValidRut("12345678-4")).toBe(false);
    expect(isValidRut("1234567")).toBe(false);
    expect(isValidRut("123456789012")).toBe(false);
    expect(isValidRut("")).toBe(false);
  });
});
