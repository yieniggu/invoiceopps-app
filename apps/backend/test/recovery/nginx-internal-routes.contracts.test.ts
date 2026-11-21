import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTROSPECTION_PATH } from "../../src/features/api-tokens/introspection.js";
import { SESSION_INTROSPECTION_PATH } from "../../src/features/api-tokens/session-introspection.js";
import {
  EXCHANGE_PATH,
  REVOKE_PATH,
} from "../../src/features/mlflow-sso/routes.js";

// Read-only: the file belongs to the frontend app. The test only proves that
// no nginx route can carry a private /internal/* request to the backend.
const NGINX_CONF = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../frontend/nginx.conf",
);

interface Location {
  modifier: "" | "=" | "^~" | "~" | "~*";
  pattern: string;
  body: string;
}

/** Top-level `location` blocks of the server (no nested blocks are used). */
function parseLocations(conf: string): Location[] {
  const stripped = conf.replace(/#.*$/gm, "");
  const locations: Location[] = [];
  const header = /location\s+(?:(=|\^~|~\*|~)\s+)?(\S+)\s*\{/g;
  for (
    let match = header.exec(stripped);
    match;
    match = header.exec(stripped)
  ) {
    let depth = 1;
    let index = header.lastIndex;
    while (depth > 0 && index < stripped.length) {
      const char = stripped[index++];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }
    locations.push({
      modifier: (match[1] ?? "") as Location["modifier"],
      pattern: match[2]!,
      body: stripped.slice(header.lastIndex, index - 1),
    });
    header.lastIndex = index;
  }
  return locations;
}

/** nginx's selection order: exact, longest ^~/plain prefix, first regex. */
function selectLocation(locations: Location[], path: string) {
  const exact = locations.find(
    (location) => location.modifier === "=" && location.pattern === path,
  );
  if (exact) return exact;
  const prefixes = locations
    .filter(
      (location) =>
        (location.modifier === "" || location.modifier === "^~") &&
        path.startsWith(location.pattern),
    )
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const longest = prefixes[0];
  if (longest?.modifier === "^~") return longest;
  const regex = locations.find((location) => {
    if (location.modifier !== "~" && location.modifier !== "~*") return false;
    return new RegExp(
      location.pattern,
      location.modifier === "~*" ? "i" : "",
    ).test(path);
  });
  return regex ?? longest;
}

describe("nginx does not publish the private /internal routes", () => {
  const conf = readFileSync(NGINX_CONF, "utf8");
  const locations = parseLocations(conf);

  it("parses the server locations", () => {
    expect(locations.length).toBeGreaterThan(3);
  });

  it.each([
    INTROSPECTION_PATH,
    SESSION_INTROSPECTION_PATH,
    EXCHANGE_PATH,
    REVOKE_PATH,
    "/internal/",
    "/internal",
    "//internal/sessions/exchange",
  ])("%s is never proxied", (path) => {
    const selected = selectLocation(locations, path);
    expect(selected).toBeDefined();
    expect(selected!.body).not.toMatch(/proxy_pass/);
  });

  it("only proxies the API, the OpenAPI document and the docs", () => {
    // Routes may be refined (for example a longer timeout on one API route),
    // but a proxied location must stay under one of the public prefixes.
    const allowed = /^(\/api(\/|$)|\/openapi\.json$|\/docs(\/|$))/;
    const proxied = locations.filter((location) =>
      /proxy_pass/.test(location.body),
    );
    expect(proxied.length).toBeGreaterThan(0);
    for (const location of proxied) {
      const pattern = location.pattern.replace(/^\^/, "");
      expect(
        allowed.test(pattern),
        `proxied location ${location.pattern} is outside the public prefixes`,
      ).toBe(true);
    }
  });

  it("never builds the upstream path from a variable", () => {
    expect(conf).not.toMatch(/\bproxy_pass\s+[^;]*\$/);
  });
});
