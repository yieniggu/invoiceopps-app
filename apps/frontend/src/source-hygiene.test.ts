// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`./${path}`, import.meta.url), "utf8");

// CR-595: leftovers that behavior tests cannot see.
describe("source hygiene (CR-595)", () => {
  it("InvoicePredictions uses its prop, not an alias of it", () => {
    expect(
      read("features/invoices/components/InvoicePredictions.tsx"),
    ).not.toMatch(/const shown = predictions/);
  });

  it("Dialog's comments do not cite the removed text loading state", () => {
    expect(read("components/Dialog.tsx")).not.toMatch(/Creando\.\.\./);
  });
});
