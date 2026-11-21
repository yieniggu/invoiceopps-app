// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CR-572: the predictions section is laid out with spacing and type, not with
// a card (no border, background, radius or padding on the section itself).
describe("invoice predictions styling", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const rule = css.match(/\n\.invoice-predictions\s*\{([^}]*)\}/)?.[1] ?? "";

  it("has a rule for the section", () => {
    expect(rule).toContain("display: grid");
  });

  it.each(["border", "background", "border-radius", "padding", "box-shadow"])(
    "does not set %s on the section",
    (property) => {
      expect(rule).not.toMatch(new RegExp(`(^|[\\s;])${property}\\s*:`));
    },
  );
});
