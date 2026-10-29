import { describe, expect, it } from "vitest";

import { isUuid } from "../lib/uuid";
import { namedId } from "./ids";

describe("namedId fixtures (CR-314)", () => {
  it("never gives two different keys the same id", () => {
    // Old scheme: the char codes of "a" (97) collided with the number 97, and
    // "ab" with "9798"; leading zeros collided too ("07" and 7).
    const keys: Array<string | number> = [
      "a",
      97,
      "97",
      "ab",
      9798,
      "07",
      7,
      "A",
      "B",
      "AB",
      6566,
      "g",
      "org-1",
      "org-2",
      "x".repeat(40),
      "x".repeat(41),
    ];
    const ids = keys.map((key) => namedId("org", key));
    // "97" and 97 are the same number on purpose; everything else is distinct.
    expect(new Set(ids).size).toBe(keys.length - 1);
    expect(namedId("org", "97")).toBe(namedId("org", 97));
  });

  it("is stable per key and separates kinds", () => {
    expect(namedId("group", "g")).toBe(namedId("group", "g"));
    expect(namedId("group", "g")).not.toBe(namedId("org", "g"));
    expect(namedId("user", "g")).not.toBe(namedId("org", "g"));
  });

  it("always yields a UUID the transport accepts", () => {
    for (const key of ["a", "A", 1, "07", "x".repeat(80), "ñ", 123456789012])
      expect(isUuid(namedId("user", key))).toBe(true);
  });
});
