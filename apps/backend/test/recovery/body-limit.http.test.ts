import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import {
  MAX_ORGANIZATIONS_PER_USER_CREATION,
  MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION,
} from "../../src/features/admin-users/schemas.js";
import type { AdminUserService } from "../../src/features/admin-users/services.js";
import type {
  GroupCatalogService,
  GroupService,
} from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";
import type { UserService } from "../../src/features/users/services.js";
import request from "../support/request.js";

// CR-211: JSON bodies are limited to 16 kB, except the five batch operations
// that carry up to 200 members with their own permissions (64 kB).

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "o1";
const GROUP = "g1";

const FLAGS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};

const profile = {
  id: "user-1",
  name: "Ada",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: true,
  memberships: [],
};

function harness() {
  const groups = {
    addMembers: vi.fn(async (_a, _o, _g, members: unknown[]) => members),
    updateMembersPermissions: vi.fn(async () => []),
    listGroups: vi.fn(async () => []),
  };
  const organizations = {
    updateMembershipsPermissions: vi.fn(async () => []),
  };
  const users = {
    provisionUser: vi.fn(async () => ({ user: {}, temporaryPassword: "x" })),
  };
  const adminUsers = {
    createUser: vi.fn(async () => ({ user: {}, memberships: [] })),
  };
  const auth = {
    login: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(async () => profile),
    updateProfile: vi.fn(async () => profile),
  } as unknown as AuthService;
  const app = createApp({ isReady: async () => true }, auth, {
    groups: groups as unknown as GroupCatalogService,
    groupAdministration: groups as unknown as GroupService,
    organizations: organizations as unknown as OrganizationService,
    users: users as unknown as UserService,
    adminUsers: adminUsers as unknown as AdminUserService,
  });
  return { app, groups, organizations, users, adminUsers };
}

function send(
  app: ReturnType<typeof harness>["app"],
  method: "post" | "put",
  path: string,
  body: unknown,
) {
  const agent = request(app);
  return agent[method](`/api/v1${path}`)
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE)
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));
}

const members = (count: number) =>
  Array.from({ length: count }, () => ({
    userId: randomUUID(),
    permissions: FLAGS,
  }));
const userIds = (count: number) =>
  Array.from({ length: count }, () => randomUUID());

const bulkAdd = `/organizations/${ORG}/groups/${GROUP}/memberships/bulk`;
const bulkGroupPermissions = `/organizations/${ORG}/groups/${GROUP}/memberships/permissions`;
const bulkOrgPermissions = `/organizations/${ORG}/memberships/permissions`;

describe("64 kB batch operations", () => {
  it("is larger than the global limit for the 200-member body", () => {
    expect(JSON.stringify({ members: members(200) }).length).toBeGreaterThan(
      16 * 1024,
    );
  });

  it("accepts 200 members with permissions on the bulk group add", async () => {
    const { app, groups } = harness();
    const response = await send(app, "post", bulkAdd, {
      members: members(200),
    });
    expect(response.status).toBe(201);
    expect(groups.addMembers).toHaveBeenCalledTimes(1);
  });

  it("rejects 201 members on the bulk group add with 400, not 413", async () => {
    const { app, groups } = harness();
    const response = await send(app, "post", bulkAdd, {
      members: members(201),
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(groups.addMembers).not.toHaveBeenCalled();
  });

  it.each([
    ["bulk group permissions", bulkGroupPermissions],
    ["bulk organization permissions", bulkOrgPermissions],
  ])("accepts 200 and rejects 201 user ids on %s", async (_label, path) => {
    const { app, groups, organizations } = harness();
    const ok = await send(app, "put", path, {
      userIds: userIds(200),
      permissions: FLAGS,
    });
    expect(ok.status).toBe(200);
    const bad = await send(app, "put", path, {
      userIds: userIds(201),
      permissions: FLAGS,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      groups.updateMembersPermissions.mock.calls.length +
        organizations.updateMembershipsPermissions.mock.calls.length,
    ).toBe(1);
  });

  it.each([
    ["bulk group add", "post", bulkAdd, () => ({ members: members(200) })],
    [
      "bulk group permissions",
      "put",
      bulkGroupPermissions,
      () => ({ userIds: userIds(200), permissions: FLAGS }),
    ],
    [
      "bulk organization permissions",
      "put",
      bulkOrgPermissions,
      () => ({ userIds: userIds(200), permissions: FLAGS }),
    ],
    [
      "organization user creation",
      "post",
      `/organizations/${ORG}/users`,
      () => ({ name: "Ada", rut: "123456785", role: "USER" }),
    ],
    [
      "platform user creation",
      "post",
      "/admin/users",
      () => ({ name: "Ada", rut: "123456785", memberships: [] }),
    ],
  ] as const)(
    "answers 413 above 64 kB on %s",
    async (_label, method, path, build) => {
      const { app } = harness();
      const response = await send(app, method, path, {
        ...build(),
        padding: "x".repeat(65 * 1024),
      });
      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    },
  );

  it("lets the platform user creation carry a body between 16 and 64 kB", async () => {
    const { app } = harness();
    const response = await send(app, "post", "/admin/users", {
      name: "Ada",
      rut: "123456785",
      memberships: [],
      padding: "x".repeat(20 * 1024),
    });
    // The unknown field is a validation error (400), proving the body was read
    // past the 16 kB global limit.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

/**
 * The largest valid POST /admin/users: every organization of the cap, every
 * group grant of the cap spread over them, all flags set, UUID identifiers
 * and the longest name and defined password.
 */
function maximalAdminUserBody() {
  const organizations = MAX_ORGANIZATIONS_PER_USER_CREATION;
  const total = MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION;
  return {
    name: "n".repeat(120),
    rut: "12.345.678-5",
    temporaryPassword: "p".repeat(256),
    memberships: Array.from({ length: organizations }, (_unused, index) => ({
      organizationId: randomUUID(),
      role: "ADMIN",
      permissions: FLAGS,
      groups: Array.from(
        {
          length:
            Math.floor(total / organizations) +
            (index < total % organizations ? 1 : 0),
        },
        () => ({ groupId: randomUUID(), permissions: FLAGS }),
      ),
    })),
  };
}

describe("POST /admin/users group grants (CR-251)", () => {
  it("accepts the maximal valid body, which fits in 64 kB", async () => {
    const { app, adminUsers } = harness();
    const body = maximalAdminUserBody();
    const bytes = Buffer.byteLength(JSON.stringify(body));
    expect(
      body.memberships.reduce((sum, { groups }) => sum + groups.length, 0),
    ).toBe(MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION);
    // Real headroom, not a body that just squeezes in.
    expect(bytes).toBeLessThan(48 * 1024);

    const response = await send(app, "post", "/admin/users", body);

    expect(response.status).toBe(201);
    expect(adminUsers.createUser).toHaveBeenCalledTimes(1);
  });

  it("rejects one group grant more than the cap with 400, not 413", async () => {
    const { app, adminUsers } = harness();
    const body = maximalAdminUserBody();
    body.memberships[0].groups.push({
      groupId: randomUUID(),
      permissions: FLAGS,
    });

    const response = await send(app, "post", "/admin/users", body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("counts grants over all memberships, not per organization", async () => {
    const { app, adminUsers } = harness();
    const group = () => ({ groupId: randomUUID() });
    const response = await send(app, "post", "/admin/users", {
      name: "Ada",
      rut: "123456785",
      memberships: [
        {
          organizationId: randomUUID(),
          role: "USER",
          groups: Array.from({ length: 120 }, group),
        },
        {
          organizationId: randomUUID(),
          role: "USER",
          groups: Array.from({ length: 81 }, group),
        },
      ],
    });
    // Each organization is under its own limit; together they are 201.
    expect(response.status).toBe(400);
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("documents the cap in the OpenAPI request schema and the 400 response", async () => {
    const { app } = harness();
    const document = (await request(app).get("/openapi.json")).body as {
      components: { schemas: Record<string, { description?: string }> };
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description: string }> }>
      >;
    };
    expect(
      document.components.schemas.AdminUserCreateRequest?.description,
    ).toContain(`${MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION} group grants`);
    expect(
      document.paths["/api/v1/admin/users"]?.post?.responses["400"]
        ?.description,
    ).toContain("group grants in total");
  });

  it("is the same cap the create-user wizard enforces", () => {
    const source = readFileSync(
      new URL("../../../frontend/src/lib/limits.ts", import.meta.url),
      "utf8",
    );
    const match = /MAX_TOTAL_GROUP_GRANTS\s*=\s*(\d+)/.exec(source);
    expect(Number(match?.[1])).toBe(MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION);
  });
});

describe("16 kB everywhere else", () => {
  it.each([
    ["post", `/organizations/${ORG}/groups`],
    ["post", `/organizations/${ORG}/groups/${GROUP}/memberships`],
    ["post", `/organizations/${ORG}/memberships`],
    ["put", `/organizations/${ORG}/memberships/u1/permissions`],
    ["post", "/auth/login"],
  ] as const)("answers 413 above 16 kB on %s %s", async (method, path) => {
    const { app } = harness();
    const response = await send(app, method, path, {
      padding: "x".repeat(17 * 1024),
    });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("OpenAPI documents the limit", () => {
  it("documents 64 kB on the batch operations and 16 kB elsewhere", async () => {
    const { app } = harness();
    const document = (await request(app).get("/openapi.json")).body as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description: string }> }>
      >;
    };
    const large: Array<[string, string]> = [
      ["post", "/api/v1/admin/users"],
      ["post", "/api/v1/organizations/{organizationId}/users"],
      [
        "post",
        "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/bulk",
      ],
      [
        "put",
        "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/permissions",
      ],
      ["put", "/api/v1/organizations/{organizationId}/memberships/permissions"],
    ];
    for (const [method, path] of large) {
      expect(
        document.paths[path]?.[method]?.responses["413"]?.description,
      ).toBe("PAYLOAD_TOO_LARGE: the JSON body exceeds 64 kB");
    }
    expect(
      document.paths["/api/v1/organizations/{organizationId}/groups"]?.post
        ?.responses["413"]?.description,
    ).toBe("PAYLOAD_TOO_LARGE: the JSON body exceeds 16 kB");
  });
});
