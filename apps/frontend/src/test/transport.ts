import { vi } from "vitest";

import { isUuid } from "../lib/uuid";

// Transport-level test double: only the global fetch is replaced, so every
// screen, hook and QueryClient under test is the real one.

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Envelope of the paginated lists (GET /organizations, /memberships, /members):
 * the screens still read one page of up to 100 items, so the page echoed back
 * is the first one and total is the length of the fixture.
 */
export function pageEnvelope<K extends string, T>(key: K, items: T[]) {
  return { [key]: items, page: 1, pageSize: 100, total: items.length } as {
    page: number;
    pageSize: number;
    total: number;
  } & Record<K, T[]>;
}

export const organizationsPage = <T>(items: T[]) =>
  pageEnvelope("organizations", items);

/** GET /organizations/{o}/groups/{g}/memberships for stubs that ignore paging. */
export const groupMembershipsPage = <T>(items: T[]) =>
  pageEnvelope("memberships", items);

/** GET /organizations/{o}/users for stubs that ignore paging. */
export const usersPage = <T>(items: T[]) => pageEnvelope("users", items);

/**
 * A paginated list that pages like the real server: `page`/`pageSize` slice
 * the items, `userIds` (comma separated) keeps only those people, and `total`
 * counts what matches. Use it for fixtures larger than one page.
 */
export function pagedList<K extends string, T>(
  key: K,
  items: readonly T[],
  idOf: (item: T) => string,
  options: {
    defaultPageSize?: number;
    /** Extra filter by the `search` query parameter. */
    matches?: (item: T, search: string) => boolean;
  } = {},
) {
  return ({ search }: { search: string }) => {
    const query = new URLSearchParams(search);
    const invalid = invalidPagedQuery(query);
    if (invalid)
      return errorResponse(400, "VALIDATION_ERROR", { query: invalid });
    const ids = query.get("userIds")?.split(",");
    const text = query.get("search") ?? "";
    const page = Number(query.get("page") ?? 1);
    const pageSize = Number(
      query.get("pageSize") ?? options.defaultPageSize ?? 20,
    );
    const matching = items.filter(
      (item) =>
        (!ids || ids.includes(idOf(item))) &&
        (!text || !options.matches || options.matches(item, text)),
    );
    return jsonResponse({
      [key]: matching.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      total: matching.length,
    });
  };
}

/**
 * The server's validation of a paginated list query, so a screen that sends
 * something the real API refuses fails here too: `userIds` are 1..200 distinct
 * UUIDs, `pageSize` is 1..100 and `page` is 1..10000, all integers.
 */
function invalidPagedQuery(query: URLSearchParams): string | undefined {
  const integer = (name: string, min: number, max: number) => {
    const value = query.get(name);
    if (value === null) return undefined;
    const number = Number(value);
    return value.trim() !== "" &&
      Number.isInteger(number) &&
      number >= min &&
      number <= max
      ? undefined
      : `${name} must be an integer from ${min} to ${max}`;
  };
  const userIds = query.get("userIds");
  if (userIds !== null) {
    const ids = userIds.split(",");
    if (ids.length > 200) return "userIds must hold at most 200 ids";
    if (ids.some((id) => !isUuid(id))) return "userIds must be UUIDs";
    if (new Set(ids).size !== ids.length) return "userIds must be unique";
  }
  const search = query.get("search");
  if (search !== null && (search.trim() === "" || search.trim().length > 120))
    return "search must have 1 to 120 characters";
  return integer("pageSize", 1, 100) ?? integer("page", 1, 10_000);
}

/** Memberships page whose users carry the status fields of the server. */
export function orgMembershipsPage<T extends { user: object }>(items: T[]) {
  return pageEnvelope(
    "memberships",
    items.map((item) => ({
      ...item,
      user: { disabled: false, recentlyActive: false, ...item.user },
    })),
  );
}

export function errorResponse(
  status: number,
  code: string,
  fields?: Record<string, unknown>,
) {
  return jsonResponse(
    {
      error: { code, message: `server ${code}`, ...(fields ? { fields } : {}) },
    },
    status,
  );
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

export type RouteHandler = (
  request: RecordedRequest,
) => Response | Promise<Response>;

/** Routes are keyed "METHOD /path"; the handler map may be mutated per test. */
// Path segments that are followed by an id, and the fixed words that can
// follow them instead (`.../memberships/bulk`).
const ID_PARENTS = new Set(["organizations", "groups", "users", "memberships"]);
const FIXED_SEGMENTS = new Set(["bulk", "permissions"]);

/**
 * The server does not validate path ids as UUIDs: an id that is not one just
 * matches nothing and is answered 404 NOT_FOUND (pinned by the recovery
 * PostgreSQL tests). Mirrors that, so a fixture with an id like `org-1` fails
 * loudly instead of passing against an unrealistic server.
 */
function hasMalformedPathId(pathname: string) {
  const segments = pathname.split("/");
  return segments.some(
    (segment, index) =>
      index > 0 &&
      ID_PARENTS.has(segments[index - 1]) &&
      segment !== "" &&
      !FIXED_SEGMENTS.has(segment) &&
      !isUuid(segment),
  );
}

export function mockTransport(routes: Record<string, RouteHandler>) {
  const requests: RecordedRequest[] = [];
  const unexpected: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const request: RecordedRequest = {
        method,
        path: url.pathname,
        search: url.search,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      if (hasMalformedPathId(url.pathname))
        return errorResponse(404, "NOT_FOUND");
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) {
        unexpected.push(`${method} ${url.pathname}`);
        throw new Error(`Unexpected fetch request: ${method} ${url.pathname}`);
      }
      return handler(request);
    });
  return {
    fetchMock,
    requests,
    unexpected,
    routes,
    /** Requests matching "METHOD /path". */
    calls: (key: string) =>
      requests.filter((request) => `${request.method} ${request.path}` === key),
  };
}

export function profileFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Ada Lovelace",
    rut: "123456785",
    email: null,
    username: null,
    mustChangePassword: false,
    isPlatformAdministrator: false,
    memberships: [],
    ...overrides,
  };
}

export const ALL_PERMISSIONS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};
export const NO_PERMISSIONS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

/** Spread into raw profile memberships that do not care about v2 flags. */
export const ACCESS_NONE = {
  permissions: NO_PERMISSIONS,
  groups: [] as never[],
};

/** Profile membership (v2): organization flags plus the groups with their
 * direct and effective flags. */
export function membership(
  organization: { id: string; name: string; slug?: string },
  role: "ADMIN" | "USER" = "USER",
  extra: {
    permissions?: typeof NO_PERMISSIONS;
    groups?: Array<{
      group: { id: string; name: string };
      permissions?: typeof NO_PERMISSIONS;
      effective?: typeof NO_PERMISSIONS;
    }>;
  } = {},
) {
  return {
    organization: { slug: organization.id, ...organization },
    role,
    permissions: extra.permissions ?? NO_PERMISSIONS,
    groups: (extra.groups ?? []).map((entry) => ({
      group: entry.group,
      permissions: entry.permissions ?? NO_PERMISSIONS,
      effective: entry.effective ?? entry.permissions ?? NO_PERMISSIONS,
    })),
  };
}

/** Deferred response: resolve it from the test when the scenario requires. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Everything a QueryClient holds, as one searchable string. */
export function serializeClient(client: {
  getQueryCache(): { getAll(): Array<{ queryKey: unknown; state: unknown }> };
  getMutationCache(): {
    getAll(): Array<{ options: { mutationKey?: unknown }; state: unknown }>;
  };
}) {
  return JSON.stringify({
    queries: client
      .getQueryCache()
      .getAll()
      .map((query) => ({ key: query.queryKey, state: query.state })),
    mutations: client
      .getMutationCache()
      .getAll()
      .map((mutation) => ({
        key: mutation.options.mutationKey,
        state: mutation.state,
      })),
  });
}
