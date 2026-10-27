// Test-only helper: compares the routes actually mounted on an Express 5 app
// with the routes documented in OpenAPI plus the legacy (not yet documented)
// route registry. It never imports production code.

export interface RouteRef {
  method: string;
  path: string;
}

export interface LegacyRoute extends RouteRef {
  owner: string;
}

export interface RouteParityResult {
  /** Mounted but neither documented in OpenAPI nor registered as legacy. */
  undocumented: string[];
  /** Documented or registered as legacy but not mounted. */
  phantom: string[];
}

export interface EnumerateOptions {
  /**
   * Express 5 does not retain the mount path of `app.use(path, router)`.
   * Candidate prefixes are probed against each nested router layer and the
   * helper throws when none matches, so an unknown mount can never be silently
   * skipped.
   */
  mountPrefixes?: string[];
}

export const DEFAULT_PARITY_EXCLUSIONS: readonly string[] = [
  "/health/live",
  "/health/ready",
  "/openapi.json",
];

const IGNORED_METHODS = new Set(["HEAD", "OPTIONS", "_ALL"]);
const OPENAPI_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
];

interface RouterLayer {
  route?: { path: string; methods: Record<string, boolean | undefined> };
  handle?: { stack?: RouterLayer[] };
  slash?: boolean;
  matchers?: Array<(path: string) => false | { path: string }>;
}

/** `:id` and `{id}` both become `{id}`; a trailing slash is dropped. */
export function normalizePath(path: string): string {
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  return converted.length > 1 ? converted.replace(/\/+$/, "") : converted;
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function joinPath(prefix: string, path: string): string {
  if (prefix === "") return path;
  return path === "/" ? prefix : `${prefix}${path}`;
}

function mountPrefix(layer: RouterLayer, candidates: string[]): string {
  if (layer.slash) return "";
  for (const candidate of candidates) {
    const matched = layer.matchers?.some((match) => {
      const result = match(candidate);
      return result !== false && result.path === candidate;
    });
    if (matched) return candidate;
  }
  throw new Error(
    "Cannot determine the mount path of a nested router; pass mountPrefixes",
  );
}

function collect(
  stack: RouterLayer[],
  prefix: string,
  options: EnumerateOptions,
  into: RouteRef[],
): void {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (
          layer.route.methods[method] !== true ||
          IGNORED_METHODS.has(method.toUpperCase())
        ) {
          continue;
        }
        into.push({
          method: method.toUpperCase(),
          path: joinPath(prefix, layer.route.path),
        });
      }
    } else if (layer.handle?.stack) {
      const nested = mountPrefix(layer, options.mountPrefixes ?? ["/api/v1"]);
      collect(layer.handle.stack, `${prefix}${nested}`, options, into);
    }
  }
}

/** Enumerates routes mounted on an Express 5 app via `app.router.stack`. */
export function enumerateMountedRoutes(
  app: unknown,
  options: EnumerateOptions = {},
): RouteRef[] {
  const router = (app as { router?: { stack?: RouterLayer[] } }).router;
  if (!router?.stack) {
    throw new Error("Expected an Express 5 application exposing app.router");
  }
  const routes: RouteRef[] = [];
  collect(router.stack, "", options, routes);
  return routes;
}

/** Lists the `METHOD /path` operations of an OpenAPI document. */
export function enumerateOpenApiRoutes(document: unknown): RouteRef[] {
  const paths = (document as { paths?: Record<string, object> }).paths ?? {};
  return Object.entries(paths).flatMap(([path, item]) =>
    OPENAPI_METHODS.filter((method) => method in item).map((method) => ({
      method: method.toUpperCase(),
      path,
    })),
  );
}

function isExcluded(key: string, exclusions: readonly string[]): boolean {
  const path = key.slice(key.indexOf(" ") + 1);
  return exclusions.includes(path);
}

export function compareRouteParity({
  mounted,
  documented,
  legacy,
  exclusions = DEFAULT_PARITY_EXCLUSIONS,
}: {
  mounted: readonly RouteRef[];
  documented: readonly RouteRef[];
  legacy: readonly RouteRef[];
  exclusions?: readonly string[];
}): RouteParityResult {
  const toKeys = (routes: readonly RouteRef[]) =>
    new Set(
      routes
        .map((route) => routeKey(route.method, route.path))
        .filter((key) => !isExcluded(key, exclusions)),
    );
  const mountedKeys = toKeys(mounted);
  const expectedKeys = toKeys([...documented, ...legacy]);

  return {
    undocumented: [...mountedKeys].filter((key) => !expectedKeys.has(key)),
    phantom: [...expectedKeys].filter((key) => !mountedKeys.has(key)),
  };
}
