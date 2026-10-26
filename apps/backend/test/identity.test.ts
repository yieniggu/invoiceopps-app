import { describe, expect, it } from "vitest";

import { normalizeSlug } from "../src/identity.js";

describe("APP-01 identity normalization", () => {
  it("normalizes organization slugs", () => {
    expect(normalizeSlug(" Diplomado IA_2027 ")).toBe("diplomado-ia-2027");
  });
});
