import request from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import { ApiError } from "../../src/http/errors.js";
import type { GroupService } from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";
import type { UserService } from "../../src/features/users/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";
const ORG = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";

const organization = {
  id: ORG,
  name: "Org",
  slug: "org",
  description: null,
};

function harness(options: { mustChangePassword?: boolean } = {}) {
  const organizations = {
    listOrganizations: vi.fn(async () => ({
      organizations: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
    updateOrganization: vi.fn(async () => ({ organization, changed: true })),
    listMembers: vi.fn(async () => ({
      members: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
    listMemberships: vi.fn(async () => ({
      memberships: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
  };
  const groups = {
    listMemberships: vi.fn(async () => ({
      memberships: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
  };
  const users = {
    listUsers: vi.fn(async () => ({
      users: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
    getUser: vi.fn(async () => ({
      user: { id: TARGET, name: "Grace", email: null, recentlyActive: false },
      sharedOrganizations: [],
    })),
  };
  const profile = {
    id: ACTOR,
    name: "Ada",
    rut: "123456785",
    email: null,
    username: null,
    mustChangePassword: options.mustChangePassword ?? false,
    isPlatformAdministrator: false,
    memberships: [],
  };
  const auth = {
    login: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(async () => profile),
    updateProfile: vi.fn(async () => profile),
  } as unknown as AuthService;
  const app = createApp({ isReady: async () => true }, auth, {
    organizations: organizations as unknown as OrganizationService,
    users: users as unknown as UserService,
    groupAdministration: groups as unknown as GroupService,
  });
  return { app, organizations, users, groups };
}
type Harness = ReturnType<typeof harness>;

const get = (h: Harness, path: string) =>
  request(h.app).get(`/api/v1${path}`).set("Cookie", COOKIE);
const patch = (h: Harness, body: unknown) =>
  request(h.app)
    .patch(`/api/v1/organizations/${ORG}`)
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE)
    .send(body as object);

describe("PATCH /api/v1/organizations/{organizationId} over HTTP", () => {
  it("passes the trimmed fields to the service and returns the organization", async () => {
    const h = harness();
    const response = await patch(h, { name: "  New name  ", description: "d" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ organization });
    expect(h.organizations.updateOrganization).toHaveBeenCalledWith(
      ACTOR,
      ORG,
      { name: "New name", description: "d" },
    );
  });

  it("stores a blank or null description as null, like the create schema", async () => {
    const h = harness();
    expect((await patch(h, { description: "   " })).status).toBe(200);
    expect((await patch(h, { description: null })).status).toBe(200);
    expect(h.organizations.updateOrganization).toHaveBeenNthCalledWith(
      1,
      ACTOR,
      ORG,
      { description: null },
    );
    expect(h.organizations.updateOrganization).toHaveBeenNthCalledWith(
      2,
      ACTOR,
      ORG,
      { description: null },
    );
  });

  it.each([
    ["empty body", {}],
    ["slug (immutable)", { name: "X", slug: "other" }],
    ["slug alone", { slug: "other" }],
    ["unknown field", { name: "X", enabled: false }],
    ["blank name", { name: "   " }],
    ["name of 121", { name: "x".repeat(121) }],
    ["description of 1001", { description: "x".repeat(1_001) }],
    ["non string name", { name: 5 }],
  ])("rejects %s with 400 and calls no service", async (_label, body) => {
    const h = harness();
    // Control: the route exists and accepts a valid body.
    expect((await patch(h, { name: "Valid" })).status).toBe(200);
    h.organizations.updateOrganization.mockClear();

    const response = await patch(h, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.organizations.updateOrganization).not.toHaveBeenCalled();
  });

  it("keeps the Origin check and the onboarding gate", async () => {
    const h = harness();
    expect((await patch(h, { name: "Valid" })).status).toBe(200);
    const evil = await request(h.app)
      .patch(`/api/v1/organizations/${ORG}`)
      .set("Host", "127.0.0.1")
      .set("Origin", "http://evil.example")
      .set("Cookie", COOKIE)
      .send({ name: "X" });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("FORBIDDEN_ORIGIN");
    const pending = await patch(harness({ mustChangePassword: true }), {
      name: "X",
    });
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe("ONBOARDING_REQUIRED");
  });

  it("answers 401 without a session", async () => {
    const h = harness();
    const response = await request(h.app)
      .patch(`/api/v1/organizations/${ORG}`)
      .set(SAME_ORIGIN)
      .send({ name: "X" });
    expect(response.status).toBe(401);
  });
});

describe("paginated organization queries over HTTP", () => {
  const PAGED = [
    ["members", `/organizations/${ORG}/members`, "listMembers"],
    ["memberships", `/organizations/${ORG}/memberships`, "listMemberships"],
    ["organizations", "/organizations", "listOrganizations"],
  ] as const;

  it.each(PAGED)(
    "applies the defaults of %s and passes the parsed query",
    async (_label, path, method) => {
      const h = harness();
      expect((await get(h, path)).status).toBe(200);
      expect(h.organizations[method]).toHaveBeenCalledTimes(1);
      const calls = h.organizations[method].mock
        .calls as unknown as unknown[][];
      expect(calls[0]!.at(-1)).toEqual({ page: 1, pageSize: 20 });

      await get(h, `${path}?page=3&pageSize=100`);
      const second = h.organizations[method].mock
        .calls as unknown as unknown[][];
      expect(second[1]!.at(-1)).toEqual({ page: 3, pageSize: 100 });
    },
  );

  it.each(PAGED)(
    "rejects invalid paging of %s with 400 and calls no service",
    async (_label, path, method) => {
      const h = harness();
      // Control: the route exists.
      expect((await get(h, path)).status).toBe(200);
      h.organizations[method].mockClear();
      for (const query of [
        "?page=0",
        "?page=1000001",
        "?page=1.5",
        "?pageSize=0",
        "?pageSize=101",
        "?pageSize=abc",
        "?foo=1",
        "?page=1&page=2",
      ]) {
        const response = await get(h, `${path}${query}`);
        expect(response.status, query).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      }
      expect(h.organizations[method]).not.toHaveBeenCalled();
    },
  );

  it("parses userIds on memberships only: distinct UUIDs, 1..200, comma separated", async () => {
    const h = harness();
    const path = `/organizations/${ORG}/memberships`;
    const second = "33333333-3333-4333-8333-333333333333";
    expect(
      (await get(h, `${path}?userIds=${TARGET},${second}&pageSize=5`)).status,
    ).toBe(200);
    expect(h.organizations.listMemberships).toHaveBeenLastCalledWith(
      ACTOR,
      ORG,
      { page: 1, pageSize: 5, userIds: [TARGET, second] },
    );
    h.organizations.listMemberships.mockClear();
    const tooMany = Array.from(
      { length: 201 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ).join(",");
    for (const query of [
      "?userIds=",
      "?userIds=not-a-uuid",
      `?userIds=${TARGET},${TARGET}`,
      `?userIds=${TARGET},`,
      `?userIds=${TARGET}&userIds=${second}`,
      `?userIds=${tooMany}`,
    ]) {
      const response = await get(h, `${path}${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(h.organizations.listMemberships).not.toHaveBeenCalled();
    // The filter belongs to memberships; the other lists stay strict.
    expect(
      (await get(h, `/organizations/${ORG}/members?userIds=${TARGET}`)).status,
    ).toBe(400);
    expect((await get(h, `/organizations?userIds=${TARGET}`)).status).toBe(400);
  });

  it("parses userIds on group memberships like on organization memberships", async () => {
    const h = harness();
    const path = `/organizations/${ORG}/groups/${GROUP}/memberships`;
    const second = "44444444-4444-4444-8444-444444444444";
    expect(
      (await get(h, `${path}?userIds=${TARGET},${second}&pageSize=5`)).status,
    ).toBe(200);
    expect(h.groups.listMemberships).toHaveBeenLastCalledWith(
      ACTOR,
      ORG,
      GROUP,
      { page: 1, pageSize: 5, userIds: [TARGET, second] },
    );
    h.groups.listMemberships.mockClear();
    const tooMany = Array.from(
      { length: 201 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ).join(",");
    for (const query of [
      "?userIds=",
      "?userIds=not-a-uuid",
      `?userIds=${TARGET},${TARGET}`,
      `?userIds=${TARGET}&userIds=${second}`,
      `?userIds=${tooMany}`,
      "?search=a",
    ]) {
      const response = await get(h, `${path}${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(h.groups.listMemberships).not.toHaveBeenCalled();
  });

  it("accepts search only on the organization list, trimmed and non empty", async () => {
    const h = harness();
    expect((await get(h, "/organizations?search=%20ada%20")).status).toBe(200);
    expect(h.organizations.listOrganizations).toHaveBeenCalledWith(ACTOR, {
      search: "ada",
      page: 1,
      pageSize: 20,
    });
    for (const query of [
      "?search=",
      "?search=%20%20",
      `?search=${"x".repeat(121)}`,
    ]) {
      expect((await get(h, `/organizations${query}`)).status, query).toBe(400);
    }
    // Control above: search is valid on the list; it is unknown on the others.
    expect(
      (await get(h, `/organizations/${ORG}/members?search=a`)).status,
    ).toBe(400);
    expect(
      (await get(h, `/organizations/${ORG}/memberships?search=a`)).status,
    ).toBe(400);
  });

  it("accepts search on the organization users list: trimmed, 1..100 characters, no other filter", async () => {
    const h = harness();
    const path = `/organizations/${ORG}/users`;
    expect((await get(h, `${path}?search=%20ada%20&page=2`)).status).toBe(200);
    expect(h.users.listUsers).toHaveBeenCalledWith(ACTOR, ORG, {
      search: "ada",
      page: 2,
      pageSize: 20,
    });
    expect((await get(h, `${path}?search=${"x".repeat(100)}`)).status).toBe(
      200,
    );
    h.users.listUsers.mockClear();
    for (const query of [
      "?search=",
      "?search=%20%20",
      `?search=${"x".repeat(101)}`,
      "?search=a&search=b",
      `?userIds=${TARGET}`,
    ]) {
      const response = await get(h, `${path}${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(h.users.listUsers).not.toHaveBeenCalled();
    // Without it the list is unchanged.
    expect((await get(h, path)).status).toBe(200);
    expect(h.users.listUsers).toHaveBeenCalledWith(ACTOR, ORG, {
      page: 1,
      pageSize: 20,
    });
  });

  it("rejects a NUL character in any search term with 400, before the service (CR-304)", async () => {
    const h = harness();
    for (const path of ["/organizations", `/organizations/${ORG}/users`]) {
      for (const term of ["%00", "ada%00lovelace"]) {
        const response = await get(h, `${path}?search=${term}`);
        expect(response.status, `${path} ${term}`).toBe(400);
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
      }
    }
    expect(h.organizations.listOrganizations).not.toHaveBeenCalled();
    expect(h.users.listUsers).not.toHaveBeenCalled();
  });

  it("maps a service NOT_FOUND of /members to 404 after a 200 control", async () => {
    const h = harness();
    expect((await get(h, `/organizations/${ORG}/members`)).status).toBe(200);
    h.organizations.listMembers.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "Not found"),
    );
    const response = await get(h, `/organizations/${ORG}/members`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 401 without a session and ONBOARDING_REQUIRED while a temporary password is pending", async () => {
    const h = harness();
    const anonymous = await request(h.app).get(
      `/api/v1/organizations/${ORG}/members`,
    );
    expect(anonymous.status).toBe(401);
    const pending = await get(
      harness({ mustChangePassword: true }),
      `/organizations/${ORG}/members`,
    );
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe("ONBOARDING_REQUIRED");
  });
});

describe("GET /api/v1/users/{userId} over HTTP", () => {
  it("returns the service result for the caller and target", async () => {
    const h = harness();
    const response = await get(h, `/users/${TARGET}`);
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(TARGET);
    expect(h.users.getUser).toHaveBeenCalledWith(ACTOR, TARGET);
  });

  it("maps a service NOT_FOUND to 404 after a 200 control", async () => {
    const h = harness();
    expect((await get(h, `/users/${TARGET}`)).status).toBe(200);
    h.users.getUser.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "Not found"),
    );
    const response = await get(h, `/users/${TARGET}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 401 without a session and ONBOARDING_REQUIRED while a temporary password is pending", async () => {
    const h = harness();
    expect((await get(h, `/users/${TARGET}`)).status).toBe(200);
    const anonymous = await request(h.app).get(`/api/v1/users/${TARGET}`);
    expect(anonymous.status).toBe(401);
    const pending = await get(
      harness({ mustChangePassword: true }),
      `/users/${TARGET}`,
    );
    expect(pending.status).toBe(403);
    expect(pending.body.error.code).toBe("ONBOARDING_REQUIRED");
  });
});
