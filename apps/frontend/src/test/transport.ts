import { vi } from "vitest";

// Transport-level test double: only the global fetch is replaced, so every
// screen, hook and QueryClient under test is the real one.

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
    id: "user-1",
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
