import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const html = readFileSync(resolve(__dirname, "../index.html"), "utf8");

/** The inline script is the only classic (non-module) script in the head. */
function bootstrapSource() {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("inline theme script not found");
  return match[1];
}

interface FakeEnv {
  stored?: string | null;
  storageThrows?: boolean;
  dark?: boolean;
  matchMediaThrows?: boolean;
  noMatchMedia?: boolean;
}

function run(env: FakeEnv) {
  const attributes = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem(key: string) {
        if (env.storageThrows) throw new Error("blocked");
        return key === "invoiceops.theme" ? (env.stored ?? null) : null;
      },
    },
    matchMedia: env.noMatchMedia
      ? undefined
      : (query: string) => {
          if (env.matchMediaThrows) throw new Error("unsupported");
          return { matches: query.includes("dark") && !!env.dark };
        },
  };
  const fakeDocument = {
    documentElement: {
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
    },
  };
  new Function("window", "document", bootstrapSource())(
    fakeWindow,
    fakeDocument,
  );
  return attributes.get("data-theme");
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("index.html theme bootstrap", () => {
  it("runs before the module bundle", () => {
    expect(html.indexOf("<script>")).toBeGreaterThan(-1);
    expect(html.indexOf("<script>")).toBeLessThan(
      html.indexOf('type="module"'),
    );
  });

  it("applies a stored dark or light value over the system preference", () => {
    expect(run({ stored: "dark", dark: false })).toBe("dark");
    expect(run({ stored: "light", dark: true })).toBe("light");
  });

  it("follows the system preference without a stored value", () => {
    expect(run({ dark: true })).toBe("dark");
    expect(run({ dark: false })).toBe("light");
  });

  it("ignores unknown stored values", () => {
    expect(run({ stored: "sepia", dark: true })).toBe("dark");
  });

  it("falls back to the system preference when storage throws", () => {
    expect(run({ storageThrows: true, dark: true })).toBe("dark");
    expect(run({ storageThrows: true, dark: false })).toBe("light");
  });

  it("falls back to light when matchMedia is missing or throws", () => {
    expect(run({ noMatchMedia: true })).toBe("light");
    expect(run({ matchMediaThrows: true })).toBe("light");
    expect(run({ storageThrows: true, noMatchMedia: true })).toBe("light");
  });

  it("sets data-theme on the real jsdom document", () => {
    window.localStorage.setItem("invoiceops.theme", "dark");
    new Function("window", "document", bootstrapSource())(window, document);
    expect(document.documentElement.dataset.theme).toBe("dark");
    window.localStorage.clear();
  });
});
