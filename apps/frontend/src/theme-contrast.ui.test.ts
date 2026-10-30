import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  contrastRatio as contrast,
  parseColor,
  readTokens,
  resolveToken,
} from "./test/cssTokens";

const css = readFileSync(resolve(__dirname, "styles.css"), "utf8");

const themes = {
  light: readTokens(css, ":root"),
  dark: readTokens(css, ':root[data-theme="dark"]'),
};

/**
 * [foreground, background, minimum ratio]. 4.5 = normal text; 3 = large
 * text, icons, control borders and the focus ring.
 * Decorative (not asserted, the control or text carries meaning on its own):
 * --color-border (card/sidebar/table dividers) and --color-skeleton.
 * Alpha colors (--color-overlay, --color-scrim) are asserted below as valid
 * colors with alpha > 0: they have no fixed backdrop to measure against.
 * Status badges pair each --color-status-*-fg with its -bg; the overdue
 * text reuses the pending foreground on the surfaces rows sit on.
 */
const pairs: [string, string, number][] = [
  ["--color-text", "--color-bg", 4.5],
  ["--color-text", "--color-surface", 4.5],
  ["--color-text", "--color-surface-muted", 4.5],
  ["--color-text", "--color-primary-soft", 4.5],
  ["--color-text", "--color-primary-tint", 4.5],
  ["--color-text-muted", "--color-surface", 4.5],
  ["--color-text-muted", "--color-bg", 4.5],
  ["--color-text-muted", "--color-surface-muted", 4.5],
  ["--color-primary", "--color-surface", 4.5],
  ["--color-primary", "--color-bg", 4.5],
  ["--color-primary", "--color-primary-soft", 4.5],
  ["--color-primary-strong", "--color-primary-tint", 4.5],
  ["--color-primary-strong", "--color-primary-soft", 4.5],
  ["--color-primary-strong", "--color-surface", 4.5],
  ["--color-on-primary", "--color-primary", 4.5],
  ["--color-on-danger", "--color-danger", 4.5],
  ["--color-error", "--color-surface", 4.5],
  ["--color-border-strong", "--color-surface", 3],
  ["--color-border-strong", "--color-surface-muted", 3],
  ["--color-border-strong", "--color-bg", 3],
  ["--color-primary", "--color-surface", 3],
  ["--focus-ring", "--color-bg", 3],
  ["--focus-ring", "--color-surface", 3],
  ["--focus-ring", "--color-surface-muted", 3],
  ["--focus-ring", "--color-primary-soft", 3],
  ["--focus-ring", "--color-primary-tint", 3],
  ["--color-status-pending-fg", "--color-status-pending-bg", 4.5],
  ["--color-status-approved-fg", "--color-status-approved-bg", 4.5],
  ["--color-status-rejected-fg", "--color-status-rejected-bg", 4.5],
  ["--color-status-neutral-fg", "--color-status-neutral-bg", 4.5],
  ["--color-status-pending-fg", "--color-surface", 4.5],
  ["--color-status-pending-fg", "--color-primary-soft", 4.5],
  ["--color-text-muted", "--color-primary-soft", 4.5],
];

describe("theme token contrast", () => {
  it("declares color-scheme for both themes", () => {
    expect(themes.light["color-scheme"]).toBeUndefined();
    expect(css).toMatch(/:root\s*{[^}]*color-scheme:\s*light;/);
    expect(css).toMatch(
      /:root\[data-theme="dark"\]\s*{[^}]*color-scheme:\s*dark;/,
    );
  });

  it("defines the same color tokens in both themes", () => {
    const names = (map: Record<string, string>) =>
      Object.keys(map)
        .filter(
          (name) => name.startsWith("--color-") || name === "--focus-ring",
        )
        .sort();
    expect(names(themes.dark)).toEqual(names(themes.light));
  });

  for (const [themeName, map] of Object.entries(themes)) {
    describe(themeName, () => {
      it.each(pairs)("%s on %s is at least %s:1", (fg, bg, min) => {
        expect(
          contrast(resolveToken(map, fg), resolveToken(map, bg)),
        ).toBeGreaterThanOrEqual(min);
      });
    });
  }

  it.each(Object.entries(themes))(
    "%s overlay and scrim are translucent colors",
    (_name, map) => {
      for (const token of ["--color-overlay", "--color-scrim"]) {
        const { a } = parseColor(resolveToken(map, token));
        expect(a, token).toBeGreaterThan(0);
        expect(a, token).toBeLessThan(1);
      }
    },
  );

  it("fails below the threshold (sanity check of the calculator)", () => {
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});
