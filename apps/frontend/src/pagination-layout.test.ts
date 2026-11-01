import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// jsdom does no layout, so where a paginator sits is checked in the browser
// (e2e `pagination.spec.ts`). What can be pinned here is the contract that
// makes it sit at the bottom: the stylesheet rules that stretch a screen and
// push `.pagination` to its end, and every screen that renders
// `PaginationControls` (or is hosted by one that does) opting into that fill
// layout through a `className`, so a new paginated screen cannot ship without
// it.

/** `src/`, resolved from this file so the cwd of the runner does not matter. */
const SRC = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

/** A style rule, with the at-rules (`@media …`) it sits inside, if any. */
interface Rule {
  selectors: string[];
  declarations: Map<string, string>;
  conditions: string[];
}

/**
 * Every style rule of a stylesheet, however deep inside `@media`/`@supports`
 * blocks, so an override that only applies at some width is seen too.
 * (`@font-face`/`@keyframes` bodies carry no layout selectors and are kept
 * apart by being skipped.)
 */
function parseRules(source: string): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const walk = (from: number, to: number, conditions: string[]) => {
    let cursor = from;
    while (cursor < to) {
      const open = text.indexOf("{", cursor);
      if (open === -1 || open >= to) return;
      let depth = 1;
      let close = open + 1;
      while (depth > 0 && close < to) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
        close += 1;
      }
      const prelude = text.slice(cursor, open).replace(/\s+/g, " ").trim();
      const inner = [open + 1, close - 1] as const;
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|layer|container)/.test(prelude))
          walk(inner[0], inner[1], [...conditions, prelude]);
      } else {
        const declarations = new Map<string, string>();
        for (const part of text.slice(inner[0], inner[1]).split(";")) {
          const colon = part.indexOf(":");
          if (colon > 0)
            declarations.set(
              part.slice(0, colon).trim(),
              part
                .slice(colon + 1)
                .replace(/\s+/g, " ")
                .trim(),
            );
        }
        rules.push({
          selectors: splitSelectors(prelude),
          declarations,
          conditions,
        });
      }
      cursor = close;
    }
  };
  walk(0, text.length, []);
  return rules;
}

/** Splits a selector list on the commas that are not inside `:is(...)`. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The properties a rule may not change on the fill layout, with the only value
 * each may take wherever it appears (base rule or any media query).
 */
const FILL_CONTRACT: Record<string, string> = {
  display: "flex",
  "flex-direction": "column",
  flex: "1 1 auto",
};
const FILL_BREAKERS = [
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "float",
  "position",
  "height",
  "max-height",
];
const PAGER_MARGINS = ["margin-block-start", "margin-top", "margin-block"];

/** Rules that style the fill containers themselves (not their descendants). */
const fillRules = (rules: Rule[]) =>
  rules.filter(({ selectors }) =>
    selectors.some((selector) =>
      /\.(?:screen-fill|fill-column)(?![\w-])$/.test(
        selector.replace(/\)$/, ""),
      ),
    ),
  );
/** Rules whose subject is the pager inside a fill container. */
const pagerRules = (rules: Rule[]) =>
  rules.filter(({ selectors }) =>
    selectors.some((selector) => /\.pagination$/.test(selector)),
  );
const mainRules = (rules: Rule[]) =>
  rules.filter(({ selectors }) =>
    selectors.some((selector) => /^\.app-shell main$/.test(selector)),
  );

/** What would break the contract anywhere in `rules`, as readable lines. */
function violations(rules: Rule[]): string[] {
  const found: string[] = [];
  const where = ({ selectors, conditions }: Rule) =>
    `${selectors.join(", ")}${conditions.length ? ` inside ${conditions.join(" ")}` : ""}`;
  for (const rule of fillRules(rules)) {
    for (const [property, value] of rule.declarations) {
      const required = FILL_CONTRACT[property];
      if (required !== undefined && value !== required)
        found.push(`${where(rule)} sets ${property}: ${value}`);
      if (FILL_BREAKERS.includes(property))
        found.push(`${where(rule)} sets ${property}: ${value}`);
    }
  }
  for (const rule of pagerRules(rules)) {
    for (const [property, value] of rule.declarations) {
      if (PAGER_MARGINS.includes(property) && value !== "auto")
        found.push(`${where(rule)} sets ${property}: ${value}`);
      if (property === "position" && value !== "static")
        found.push(`${where(rule)} sets ${property}: ${value}`);
      if (property === "order")
        found.push(`${where(rule)} sets ${property}: ${value}`);
    }
  }
  for (const rule of mainRules(rules)) {
    for (const property of ["display", "flex-direction"]) {
      const value = rule.declarations.get(property);
      const required = property === "display" ? "flex" : "column";
      if (value !== undefined && value !== required)
        found.push(`${where(rule)} sets ${property}: ${value}`);
    }
  }
  return found;
}

describe("the stylesheet makes a screen fill the area", () => {
  const rules = parseRules(read("styles.css"));
  const has = (rule: Rule | undefined, property: string, value: string) =>
    rule?.declarations.get(property) === value;
  /** The unconditional rules whose selector list contains `selector`. */
  const base = (selector: string) =>
    rules.filter(
      (rule) =>
        rule.conditions.length === 0 && rule.selectors.includes(selector),
    );

  it("keeps main a flex column, so a child can grow to the bottom", () => {
    const [main] = base(".app-shell main");
    expect(has(main, "display", "flex")).toBe(true);
    expect(has(main, "flex-direction", "column")).toBe(true);
  });

  it("lets .screen-fill and .fill-column grow in a column", () => {
    for (const name of [".screen-fill", ".fill-column"]) {
      const [rule] = base(name);
      expect(has(rule, "flex", "1 1 auto"), name).toBe(true);
      expect(has(rule, "display", "flex"), name).toBe(true);
      expect(has(rule, "flex-direction", "column"), name).toBe(true);
    }
  });

  it("pushes the pagination to the end of its fill container", () => {
    const [rule] = base(":is(.screen-fill, .fill-column) > .pagination");
    expect(has(rule, "margin-block-start", "auto")).toBe(true);
  });

  it("is not undone by any other rule, media queries included", () => {
    expect(violations(rules)).toEqual([]);
  });

  it("leaves the paginated pick list without an inner scroll box (CR-367)", () => {
    const own = rules.filter(({ selectors }) =>
      selectors.some((selector) => /\.checkbox-list(?![\w-])/.test(selector)),
    );
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) {
      for (const property of ["max-height", "height", "overflow", "overflow-y"])
        expect(rule.declarations.has(property), property).toBe(false);
    }
  });

  it("sees an override that only applies at some width", () => {
    const broken = parseRules(`
      .screen-fill, .fill-column { display: flex; flex: 1 1 auto; flex-direction: column; }
      @media (max-width: 40rem) {
        .fill-column { display: block; }
        .screen-fill { flex-direction: row }
        .app-shell main { display: grid }
        :is(.screen-fill, .fill-column) > .pagination { margin-block-start: 1rem; }
      }
    `);
    expect(violations(broken)).toEqual([
      ".fill-column inside @media (max-width: 40rem) sets display: block",
      ".screen-fill inside @media (max-width: 40rem) sets flex-direction: row",
      ":is(.screen-fill, .fill-column) > .pagination inside @media (max-width: 40rem) sets margin-block-start: 1rem",
      ".app-shell main inside @media (max-width: 40rem) sets display: grid",
    ]);
  });
});

describe("paginated screens fill the area", () => {
  const sources: Record<string, string> = {};
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
    if (file.endsWith(".tsx") && !file.includes(".test."))
      sources[`./${file.split("\\").join("/")}`] = read(file);
  }
  /** The class names of every `className` attribute (string or expression). */
  const classNames = (text: string) =>
    [
      ...text.matchAll(
        /className\s*=\s*(?:"([^"]*)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g,
      ),
    ].flatMap(([, quoted, expression]) =>
      (quoted ?? expression).split(/[^\w-]+/),
    );
  const fills = (text: string) =>
    classNames(text).some(
      (name) => name === "screen-fill" || name === "fill-column",
    );
  const nameOf = (file: string) =>
    file.replace(/^.*\//, "").replace(".tsx", "");
  /** Files whose source imports the component of `file`. */
  const hosts = (file: string) =>
    Object.keys(sources).filter(
      (other) =>
        other !== file &&
        new RegExp(`from\\s+"[^"]*/${nameOf(file)}"`).test(sources[other]),
    );
  const paginated = Object.keys(sources)
    .filter(
      (file) =>
        !file.endsWith("/PaginationControls.tsx") &&
        sources[file].includes("<PaginationControls"),
    )
    .sort();

  it("knows every screen that paginates", () => {
    expect(paginated).toEqual([
      "./features/admin/screens/AdminUsersScreen.tsx",
      "./features/api-tokens/screens/ApiTokensScreen.tsx",
      "./features/groups/screens/AddGroupMembersScreen.tsx",
      "./features/invoices/screens/InvoiceInboxScreen.tsx",
      "./features/members/MembersTableScreen.tsx",
      "./features/orgs/components/OrganizationDirectory.tsx",
      "./features/orgs/screens/OrganizationMembersScreen.tsx",
    ]);
  });

  it("puts each of them in a fill layout, itself or through the screen that renders it", () => {
    for (const file of paginated) {
      const hosted = hosts(file).filter((host) => fills(sources[host]));
      expect(
        fills(sources[file]) || hosted.length > 0,
        relative(".", file),
      ).toBe(true);
    }
  });

  it("does not count the bare words in comments or strings", () => {
    expect(fills("// a screen-fill layout\nconst a = 'fill-column';")).toBe(
      false,
    );
    expect(fills('<div className="screen-stack screen-fill" />')).toBe(true);
    expect(fills("<form className={`x ${y} fill-column`} />")).toBe(true);
  });
});
