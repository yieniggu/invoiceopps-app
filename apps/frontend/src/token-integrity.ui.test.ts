import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseColor, readTokens, resolveToken } from "./test/cssTokens";

const css = readFileSync(resolve(__dirname, "styles.css"), "utf8");

const blocks = {
  light: readTokens(css, ":root"),
  dark: readTokens(css, ':root[data-theme="dark"]'),
};

describe("token parser", () => {
  const fixture = `
    /* :root { --ignored: 1; } */
    @media (min-width: 1px) { .x { --nested: red; } }
    :root { --a: #fff; --b: var(--a); --c: rgb(1 2 3 / 0.5); }
    :root[data-theme="dark"] { --a: #000; }
  `;
  it("ignores comments and nested blocks, and matches the exact selector", () => {
    expect(readTokens(fixture, ":root")).toEqual({
      "--a": "#fff",
      "--b": "var(--a)",
      "--c": "rgb(1 2 3 / 0.5)",
    });
    expect(readTokens(fixture, ':root[data-theme="dark"]')).toEqual({
      "--a": "#000",
    });
  });
  it("detects self references and cycles", () => {
    expect(() => resolveToken({ "--x": "var(--x)" }, "--x")).toThrow(
      /circular/,
    );
    expect(() =>
      resolveToken({ "--x": "var(--y)", "--y": "var(--x)" }, "--x"),
    ).toThrow(/circular/);
    expect(resolveToken({ "--x": "var(--y)", "--y": "#abc" }, "--x")).toBe(
      "#abc",
    );
  });
  it("parses hex and rgb()/rgba() with alpha", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("rgb(15 23 42 / 0.55)").a).toBeCloseTo(0.55);
    expect(parseColor("rgba(0, 0, 0, 0.6)").a).toBeCloseTo(0.6);
    expect(() => parseColor("var(--x)")).toThrow();
  });
});

describe.each(Object.entries(blocks))("%s tokens", (_theme, map) => {
  it("has no self-referential or circular custom property", () => {
    for (const name of Object.keys(map)) {
      expect(() => resolveToken(map, name), name).not.toThrow();
    }
  });

  it("resolves every color token and the focus ring to a concrete color", () => {
    const names = Object.keys(map).filter(
      (name) => name.startsWith("--color-") || name === "--focus-ring",
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(() => parseColor(resolveToken(map, name)), name).not.toThrow();
    }
  });

  it("keeps the overlay and scrim visible (alpha above zero)", () => {
    for (const name of ["--color-overlay", "--color-scrim"]) {
      expect(parseColor(resolveToken(map, name)).a, name).toBeGreaterThan(0);
    }
  });
});
