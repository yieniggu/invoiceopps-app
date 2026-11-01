import { describe, expect, it } from "vitest";

import {
  amountFailureMessage,
  MAX_AMOUNT_PESOS,
  parseAmountPesos,
} from "./invoiceAmount";

const ok = (pesos: number) => ({ ok: true, pesos });
const fail = (failure: string) => ({ ok: false, failure });

describe("parseAmountPesos", () => {
  it.each([
    ["12500", 12500],
    ["12.500", 12500],
    ["$12.500", 12500],
    ["$ 12.500", 12500],
    ["  12500  ", 12500],
    ["1.234.567", 1234567],
    ["1", 1],
    [String(MAX_AMOUNT_PESOS), MAX_AMOUNT_PESOS],
    ["2.147.483.647", MAX_AMOUNT_PESOS],
    ["1.000", 1000],
    ["12.500", 12500],
  ])("accepts %j as %i pesos", (text, pesos) => {
    expect(parseAmountPesos(text)).toEqual(ok(pesos));
  });

  it("rejects an empty text", () => {
    expect(parseAmountPesos("")).toEqual(fail("empty"));
    expect(parseAmountPesos("  $ ")).toEqual(fail("empty"));
  });

  it.each(["12,5", "12,50", "12.50", "1.5", "12500,00", "1.234,5", "0,5"])(
    "rejects the decimal amount %j",
    (text) => {
      expect(parseAmountPesos(text)).toEqual(fail("decimal"));
    },
  );

  it.each(["0.500", "000.500", "$0.500", "0.001", "00.123.456"])(
    "reads %j as a decimal, never as thousands (CR-322)",
    (text) => {
      expect(parseAmountPesos(text)).toEqual(fail("decimal"));
    },
  );

  it.each(["-5", "-12.500", "$-5"])("rejects the negative %j", (text) => {
    expect(parseAmountPesos(text)).toEqual(fail("negative"));
  });

  it.each(["0", "0.000", "$0"])("rejects zero (%j)", (text) => {
    expect(parseAmountPesos(text)).toEqual(fail("zero"));
  });

  it("rejects what exceeds the backend maximum", () => {
    expect(parseAmountPesos(String(MAX_AMOUNT_PESOS + 1))).toEqual(fail("max"));
    expect(parseAmountPesos("99999999999999999999")).toEqual(fail("max"));
  });

  it.each([
    "abc",
    "12a",
    "1e3",
    "12 500",
    "1.2345",
    "12..500",
    "1.23.456",
    "+5",
  ])("rejects the malformed %j", (text) => {
    expect(parseAmountPesos(text)).toEqual(fail("format"));
  });

  it("has a Spanish message for every failure", () => {
    for (const failure of [
      "empty",
      "format",
      "decimal",
      "negative",
      "zero",
      "max",
    ] as const) {
      expect(amountFailureMessage(failure)).toMatch(/monto/i);
      expect(amountFailureMessage(failure)).not.toMatch(/contexto/i);
    }
  });
});
