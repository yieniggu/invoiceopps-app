import request from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { AdminUserService } from "../../src/features/admin-users/services.js";
import type { GroupService } from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";
import type { UserService } from "../../src/features/users/services.js";

// CR-309: PostgreSQL text cannot hold a NUL, so every free-text body field is
// refused with 400 VALIDATION_ERROR before any service runs (otherwise the
// database error would surface as a 500).
const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const NUL = "\u0000";

function harness() {
  const organizations = {
    createOrganization: vi.fn(),
    updateOrganization: vi.fn(),
  };
  const groups = { createGroup: vi.fn() };
  const users = { provisionUser: vi.fn() };
  const adminUsers = { createUser: vi.fn(), updateUser: vi.fn() };
  const profile = {
    id: ACTOR,
    name: "Ada",
    rut: "123456785",
    email: null,
    username: null,
    mustChangePassword: false,
    isPlatformAdministrator: true,
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
    groupAdministration: groups as unknown as GroupService,
    users: users as unknown as UserService,
    adminUsers: adminUsers as unknown as AdminUserService,
  });
  return {
    app,
    services: [
      ...Object.values(organizations),
      ...Object.values(groups),
      ...Object.values(users),
      ...Object.values(adminUsers),
    ],
  };
}

const validOrg = {
  name: "Org",
  slug: "org",
  firstAdminRut: "12.345.678-5",
};
const validUser = { name: "Ada", rut: "12.345.678-5" };

describe("NUL in body text fields (CR-309)", () => {
  it.each([
    [
      "organization create: name",
      "post",
      "/organizations",
      { ...validOrg, name: `a${NUL}b` },
    ],
    [
      "organization create: description",
      "post",
      "/organizations",
      { ...validOrg, description: `a${NUL}b` },
    ],
    [
      "organization patch: name",
      "patch",
      `/organizations/${ORG}`,
      { name: `a${NUL}b` },
    ],
    [
      "organization patch: description",
      "patch",
      `/organizations/${ORG}`,
      { description: `a${NUL}b` },
    ],
    [
      "group create: name",
      "post",
      `/organizations/${ORG}/groups`,
      { name: `a${NUL}b` },
    ],
    [
      "group create: description",
      "post",
      `/organizations/${ORG}/groups`,
      { name: "G", description: `a${NUL}b` },
    ],
    [
      "organization user create: name",
      "post",
      `/organizations/${ORG}/users`,
      { ...validUser, role: "USER", name: `a${NUL}b` },
    ],
    [
      "admin user create: name",
      "post",
      "/admin/users",
      { ...validUser, memberships: [], name: `a${NUL}b` },
    ],
    [
      "admin user patch: name",
      "patch",
      `/admin/users/${USER}`,
      { name: `a${NUL}b` },
    ],
  ] as const)(
    "%s answers 400 VALIDATION_ERROR and never reaches the service",
    async (_label, method, path, body) => {
      const h = harness();
      const agent = request(h.app);
      const response = await agent[method](`/api/v1${path}`)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(body);

      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      for (const service of h.services) expect(service).not.toHaveBeenCalled();
    },
  );

  it("control: the same bodies without NUL reach the services", async () => {
    const h = harness();
    const agent = request(h.app);
    const send = (method: "post" | "patch", path: string, body: object) =>
      agent[method](`/api/v1${path}`)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(body);
    for (const [method, path, body] of [
      ["post", "/organizations", { ...validOrg, description: "d" }],
      ["patch", `/organizations/${ORG}`, { name: "N" }],
      ["post", `/organizations/${ORG}/groups`, { name: "G", description: "d" }],
      ["post", `/organizations/${ORG}/users`, { ...validUser, role: "USER" }],
      ["post", "/admin/users", { ...validUser, memberships: [] }],
      ["patch", `/admin/users/${USER}`, { name: "N" }],
    ] as const) {
      const response = await send(method, path, body);
      expect(response.status, `${method} ${path}`).not.toBe(400);
    }
    expect(
      h.services.filter((service) => service.mock.calls.length > 0),
    ).toHaveLength(6);
  });
});
