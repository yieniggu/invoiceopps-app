import { describe, expect, it } from "vitest";

import { normalizeRut, normalizeSlug } from "../src/identity.js";

describe("APP-01 identity normalization", () => {
  it("normalizes and validates RUT values", () => {
    expect(normalizeRut("12.345.678-5")).toBe("123456785");
    expect(normalizeRut("12.345.675-0")).toBe("123456750");
    expect(normalizeRut("12.345.670-K")).toBe("12345670K");
    expect(() => normalizeRut("12.345.678-4")).toThrow(
      "RUT verification digit is invalid",
    );
  });

  it("normalizes organization slugs", () => {
    expect(normalizeSlug(" Diplomado IA_2027 ")).toBe("diplomado-ia-2027");
  });
});
