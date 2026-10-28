import request, { type Response } from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { BusinessPolicyService } from "../../src/business-policies.js";
import type {
  GroupCatalogService,
  GroupService,
} from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";
import type { UserService } from "../../src/features/users/services.js";
import type { InvoiceService } from "../../src/invoices.js";

// Characterization of the input rules: exactly which bodies and queries each
// route accepts, what the service receives, and that everything else is a 400
// VALIDATION_ERROR. The group, organization and user tables follow the
// documented RP0-06/07/08 operations; the business-policy and invoice tables
// still characterize the legacy (undocumented) routes.

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

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

function harness() {
  const group = { id: "g1" };
  const groups = {
    createGroup: vi.fn(async () => group),
    updateMemberPermissions: vi.fn(async () => ({ userId: "u1" })),
    addMember: vi.fn(async () => ({ userId: "u1" })),
    removeMember: vi.fn(async () => {}),
    listGroups: vi.fn(async () => []),
  };
  const platform = {
    createOrganization: vi.fn(async () => ({ organization: { id: "o1" } })),
    createMembership: vi.fn(async () => ({ userId: "u1" })),
    changeMembershipRole: vi.fn(async () => ({ userId: "u1" })),
    updateMembershipPermissions: vi.fn(async () => ({ userId: "u1" })),
    removeMembership: vi.fn(async () => {}),
    listOrganizations: vi.fn(async () => []),
  };
  const users = {
    provisionUser: vi.fn(async () => ({ user: {}, temporaryPassword: "x" })),
  };
  const policies = {
    listPolicies: vi.fn(async () => []),
    createPolicy: vi.fn(async () => ({ version: "v1" })),
    updatePolicy: vi.fn(async () => ({ version: "v1" })),
  };
  const invoices = {
    listInvoices: vi.fn(async () => ({ invoices: [], nextCursor: null })),
    getInvoice: vi.fn(async () => ({ invoice: {} })),
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
    organizations: platform as unknown as OrganizationService,
    users: users as unknown as UserService,
    businessPolicies: policies as unknown as BusinessPolicyService,
    invoices: invoices as unknown as InvoiceService,
  });
  return { app, groups, platform, users, policies, invoices };
}

const long = (length: number) => "x".repeat(length);

type Case = [label: string, body: unknown, expected: "reject" | unknown];

async function send(
  app: ReturnType<typeof harness>["app"],
  method: "post" | "patch" | "put",
  path: string,
  body: unknown,
) {
  const agent = request(app);
  const call = agent[method](path).set(SAME_ORIGIN).set("Cookie", COOKIE);
  if (body === undefined) return call;
  return call
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));
}

function expectRejected(response: Response) {
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("VALIDATION_ERROR");
}

describe("group create", () => {
  const cases: Case[] = [
    ["name only", { name: "A" }, { name: "A" }],
    [
      "trims name and description",
      { name: "  A  ", description: "  d  " },
      { name: "A", description: "d" },
    ],
    [
      "blank description becomes null",
      { name: "A", description: "   " },
      { name: "A", description: null },
    ],
    [
      "null description stays null",
      { name: "A", description: null },
      { name: "A", description: null },
    ],
    ["name of 120", { name: long(120) }, { name: long(120) }],
    [
      "description of 1000",
      { name: "A", description: long(1000) },
      { name: "A", description: long(1000) },
    ],
    ["numeric description", { name: "A", description: 5 }, "reject"],
    ["extra key", { name: "A", extra: 1 }, "reject"],
    ["empty name", { name: "" }, "reject"],
    ["blank name", { name: "   " }, "reject"],
    ["numeric name", { name: 5 }, "reject"],
    ["missing name", {}, "reject"],
    ["name of 121", { name: long(121) }, "reject"],
    ["description of 1001", { name: "A", description: long(1001) }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, groups } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/organizations/o1/groups",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(groups.createGroup).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(groups.createGroup).toHaveBeenCalledWith(ACTOR, "o1", expected);
    }
  });

  it("answers 401 before validating when there is no session", async () => {
    const { app } = harness();
    const response = await request(app)
      .post("/api/v1/organizations/o1/groups")
      .send({});
    expect(response.status).toBe(401);
  });
});

// RP0-22: permissions belong to memberships; the group-level PATCH is gone.
const flags = {
  readInvoices: true,
  createInvoices: false,
  deleteOwnInvoices: true,
  deleteOthersInvoices: false,
};
const allFalse = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const permissionCases: Case[] = [
  ["all four flags", { permissions: flags }, flags],
  ["all false", { permissions: allFalse }, allFalse],
  [
    "missing flag",
    { permissions: { ...flags, deleteOthersInvoices: undefined } },
    "reject",
  ],
  [
    "string flag",
    { permissions: { ...flags, readInvoices: "true" } },
    "reject",
  ],
  ["numeric flag", { permissions: { ...flags, readInvoices: 1 } }, "reject"],
  ["null flag", { permissions: { ...flags, readInvoices: null } }, "reject"],
  [
    "unknown key inside permissions",
    { permissions: { ...flags, x: true } },
    "reject",
  ],
  ["unknown top-level key", { permissions: flags, name: "B" }, "reject"],
  ["legacy name body", { name: "B" }, "reject"],
  ["flags at the top level", flags, "reject"],
  ["null permissions", { permissions: null }, "reject"],
  ["empty object", {}, "reject"],
  ["array body", [], "reject"],
  ["no body", undefined, "reject"],
];

describe("group member permissions update", () => {
  it.each(permissionCases)("%s", async (_label, body, expected) => {
    const { app, groups } = harness();
    const response = await send(
      app,
      "put",
      "/api/v1/organizations/o1/groups/g1/memberships/u1/permissions",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(groups.updateMemberPermissions).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(groups.updateMemberPermissions).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "g1",
        "u1",
        expected,
      );
    }
  });

  it("no longer serves PATCH on the group", async () => {
    const { app } = harness();
    const response = await send(
      app,
      "patch",
      "/api/v1/organizations/o1/groups/g1",
      { permissions: flags },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("organization member permissions update", () => {
  it.each(permissionCases)("%s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(
      app,
      "put",
      "/api/v1/organizations/o1/memberships/u1/permissions",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.updateMembershipPermissions).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(platform.updateMembershipPermissions).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "u1",
        expected,
      );
    }
  });
});

describe("group membership create", () => {
  const cases: Case[] = [
    ["userId", { userId: MEMBER_ID }, [MEMBER_ID, undefined]],
    ["trimmed userId", { userId: ` ${MEMBER_ID} ` }, "reject"],
    ["non-UUID userId", { userId: "u1" }, "reject"],
    [
      "userId with permissions",
      { userId: MEMBER_ID, permissions: flags },
      [MEMBER_ID, flags],
    ],
    [
      "partial permissions",
      { userId: MEMBER_ID, permissions: { readInvoices: true } },
      "reject",
    ],
    ["empty userId", { userId: "" }, "reject"],
    ["blank userId", { userId: "  " }, "reject"],
    ["numeric userId", { userId: 5 }, "reject"],
    ["extra key", { userId: MEMBER_ID, x: 1 }, "reject"],
    ["empty permissions", { userId: MEMBER_ID, permissions: {} }, "reject"],
    ["flag", { userId: MEMBER_ID, readInvoices: true }, "reject"],
    ["empty object", {}, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, groups } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/organizations/o1/groups/g1/memberships",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(groups.addMember).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(groups.addMember).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "g1",
        ...(expected as [string, unknown]),
      );
    }
  });
});

describe("organization membership", () => {
  const create: Case[] = [
    [
      "admin",
      { rut: "12.345.678-5", role: "ADMIN" },
      { rut: "123456785", role: "ADMIN" },
    ],
    [
      "RUT without separators",
      { rut: "12345678-5", role: "USER" },
      { rut: "123456785", role: "USER" },
    ],
    [
      "with permissions",
      { rut: "12.345.678-5", role: "USER", permissions: flags },
      { rut: "123456785", role: "USER", permissions: flags },
    ],
    [
      "partial permissions",
      {
        rut: "12.345.678-5",
        role: "USER",
        permissions: { readInvoices: true },
      },
      "reject",
    ],
    ["invalid RUT", { rut: "11.111.111-2", role: "USER" }, "reject"],
    ["numeric RUT", { rut: 123456785, role: "USER" }, "reject"],
    ["unknown role", { rut: "12.345.678-5", role: "OWNER" }, "reject"],
    ["lowercase role", { rut: "12.345.678-5", role: "admin" }, "reject"],
    ["missing role", { rut: "12.345.678-5" }, "reject"],
    ["missing RUT", { role: "USER" }, "reject"],
    ["legacy userId body", { userId: "u1", role: "USER" }, "reject"],
    ["extra key", { rut: "12.345.678-5", role: "USER", x: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(create)("create: %s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/organizations/o1/memberships",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.createMembership).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(platform.createMembership).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        expected,
      );
    }
  });

  const change: Case[] = [
    ["role only", { role: "USER" }, "USER"],
    ["with userId", { role: "USER", userId: "u2" }, "reject"],
    ["with permissions", { role: "USER", permissions: flags }, "reject"],
    ["empty object", {}, "reject"],
    ["unknown role", { role: "X" }, "reject"],
    ["numeric role", { role: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(change)("change role: %s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(
      app,
      "patch",
      "/api/v1/organizations/o1/memberships/u1",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.changeMembershipRole).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(platform.changeMembershipRole).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "u1",
        expected,
      );
    }
  });
});

describe("organization create", () => {
  const admin = { firstAdminRut: "12.345.678-5" };
  const canonical = { firstAdminRut: "123456785" };
  const cases: Case[] = [
    [
      "name and slug",
      { name: "Org", slug: "org-1", ...admin },
      { name: "Org", slug: "org-1", ...canonical },
    ],
    [
      "trims name, keeps slug",
      { name: " Org ", slug: "org", ...admin },
      { name: "Org", slug: "org", ...canonical },
    ],
    [
      "description trimmed",
      { name: "Org", slug: "org", description: " d ", ...admin },
      { name: "Org", slug: "org", description: "d", ...canonical },
    ],
    [
      "blank description becomes null",
      { name: "Org", slug: "org", description: " ", ...admin },
      { name: "Org", slug: "org", description: null, ...canonical },
    ],
    [
      "null description",
      { name: "Org", slug: "org", description: null, ...admin },
      { name: "Org", slug: "org", description: null, ...canonical },
    ],
    ["missing firstAdminRut", { name: "Org", slug: "org" }, "reject"],
    [
      "invalid firstAdminRut",
      { name: "Org", slug: "org", firstAdminRut: "11.111.111-2" },
      "reject",
    ],
    [
      "numeric firstAdminRut",
      { name: "Org", slug: "org", firstAdminRut: 123456785 },
      "reject",
    ],
    ["uppercase slug", { name: "Org", slug: "Org", ...admin }, "reject"],
    ["double dash slug", { name: "Org", slug: "a--b", ...admin }, "reject"],
    ["leading dash slug", { name: "Org", slug: "-a", ...admin }, "reject"],
    ["trailing dash slug", { name: "Org", slug: "a-", ...admin }, "reject"],
    ["empty slug", { name: "Org", slug: "", ...admin }, "reject"],
    ["padded slug", { name: "Org", slug: " org", ...admin }, "reject"],
    ["numeric slug", { name: "Org", slug: 5, ...admin }, "reject"],
    ["missing slug", { name: "Org", ...admin }, "reject"],
    ["blank name", { name: " ", slug: "org", ...admin }, "reject"],
    ["name of 121", { name: long(121), slug: "org", ...admin }, "reject"],
    [
      "description of 1001",
      { name: "Org", slug: "org", description: long(1001), ...admin },
      "reject",
    ],
    [
      "numeric description",
      { name: "Org", slug: "org", description: 1, ...admin },
      "reject",
    ],
    ["extra key", { name: "Org", slug: "org", x: 1, ...admin }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(app, "post", "/api/v1/organizations", body);

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.createOrganization).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(platform.createOrganization).toHaveBeenCalledWith(ACTOR, expected);
    }
  });
});

describe("organization user provisioning", () => {
  const valid = { name: " Ada ", rut: "12.345.678-5", role: "USER" };
  const cases: Case[] = [
    [
      "canonicalizes RUT and trims",
      valid,
      { name: "Ada", rut: "123456785", role: "USER" },
    ],
    [
      "with permissions and groups",
      {
        ...valid,
        permissions: flags,
        groups: [{ groupId: "g1", permissions: allFalse }, { groupId: "g2" }],
      },
      {
        name: "Ada",
        rut: "123456785",
        role: "USER",
        permissions: flags,
        groups: [{ groupId: "g1", permissions: allFalse }, { groupId: "g2" }],
      },
    ],
    [
      "duplicate groupId",
      { ...valid, groups: [{ groupId: "g1" }, { groupId: "g1" }] },
      "reject",
    ],
    [
      "too many groups",
      {
        ...valid,
        groups: Array.from({ length: 201 }, (_unused, index) => ({
          groupId: `g${index}`,
        })),
      },
      "reject",
    ],
    [
      "group with extra key",
      { ...valid, groups: [{ groupId: "g1", x: 1 }] },
      "reject",
    ],
    [
      "group without id",
      { ...valid, groups: [{ permissions: flags }] },
      "reject",
    ],
    [
      "partial permissions",
      { ...valid, permissions: { readInvoices: true } },
      "reject",
    ],
    ["groups not an array", { ...valid, groups: "g1" }, "reject"],
    ["invalid RUT", { ...valid, rut: "11.111.111-2" }, "reject"],
    ["numeric RUT", { ...valid, rut: 123456785 }, "reject"],
    ["missing RUT", { name: "Ada", role: "USER" }, "reject"],
    ["unknown role", { ...valid, role: "OWNER" }, "reject"],
    ["blank name", { ...valid, name: " " }, "reject"],
    ["name of 121", { ...valid, name: long(121) }, "reject"],
    [
      "legacy organizationId in body",
      { ...valid, organizationId: "o1" },
      "reject",
    ],
    ["extra key", { ...valid, x: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
    [
      "defined temporary password of 8",
      { ...valid, temporaryPassword: "x".repeat(8) },
      {
        name: "Ada",
        rut: "123456785",
        role: "USER",
        temporaryPassword: "x".repeat(8),
      },
    ],
    [
      "defined temporary password of 256",
      { ...valid, temporaryPassword: "x".repeat(256) },
      {
        name: "Ada",
        rut: "123456785",
        role: "USER",
        temporaryPassword: "x".repeat(256),
      },
    ],
    [
      "defined temporary password of 7",
      { ...valid, temporaryPassword: "x".repeat(7) },
      "reject",
    ],
    [
      "defined temporary password of 257",
      { ...valid, temporaryPassword: "x".repeat(257) },
      "reject",
    ],
    [
      "non-string temporary password",
      { ...valid, temporaryPassword: 12345678 },
      "reject",
    ],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, users } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/organizations/o1/users",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(users.provisionUser).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(users.provisionUser).toHaveBeenCalledWith(ACTOR, "o1", expected);
    }
  });
});

describe("legacy input: business policies", () => {
  const context = { organizationId: "o1", ownerType: "group", ownerId: "g1" };
  const query = "?organizationId=o1&ownerType=group&ownerId=g1";

  const create: Case[] = [
    [
      "version and threshold",
      { version: " v1 ", manualReviewThreshold: 0.5 },
      { version: "v1", manualReviewThreshold: 0.5 },
    ],
    [
      "threshold 0",
      { version: "v1", manualReviewThreshold: 0 },
      { version: "v1", manualReviewThreshold: 0 },
    ],
    [
      "threshold 1",
      { version: "v1", manualReviewThreshold: 1 },
      { version: "v1", manualReviewThreshold: 1 },
    ],
    [
      "threshold above 1",
      { version: "v1", manualReviewThreshold: 1.1 },
      "reject",
    ],
    [
      "negative threshold",
      { version: "v1", manualReviewThreshold: -0.1 },
      "reject",
    ],
    [
      "string threshold",
      { version: "v1", manualReviewThreshold: "0.5" },
      "reject",
    ],
    ["missing threshold", { version: "v1" }, "reject"],
    ["missing version", { manualReviewThreshold: 0.5 }, "reject"],
    ["blank version", { version: " ", manualReviewThreshold: 0.5 }, "reject"],
    [
      "version of 120",
      { version: long(120), manualReviewThreshold: 0.5 },
      {
        version: long(120),
        manualReviewThreshold: 0.5,
      },
    ],
    [
      "version of 121",
      { version: long(121), manualReviewThreshold: 0.5 },
      "reject",
    ],
    [
      "extra key",
      { version: "v1", manualReviewThreshold: 0.5, x: 1 },
      "reject",
    ],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(create)("create: %s", async (_label, body, expected) => {
    const { app, policies } = harness();
    const response = await send(
      app,
      "post",
      `/api/v1/business-policies${query}`,
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(policies.createPolicy).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(policies.createPolicy).toHaveBeenCalledWith(
        ACTOR,
        context,
        expected,
      );
    }
  });

  const update: Case[] = [
    [
      "threshold",
      { manualReviewThreshold: 0.2 },
      { manualReviewThreshold: 0.2 },
    ],
    ["with version", { version: "v2", manualReviewThreshold: 0.2 }, "reject"],
    ["empty object", {}, "reject"],
    ["threshold above 1", { manualReviewThreshold: 2 }, "reject"],
    ["null threshold", { manualReviewThreshold: null }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(update)("update: %s", async (_label, body, expected) => {
    const { app, policies } = harness();
    const response = await send(
      app,
      "patch",
      `/api/v1/business-policies/v1${query}`,
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(policies.updatePolicy).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(policies.updatePolicy).toHaveBeenCalledWith(
        ACTOR,
        context,
        "v1",
        expected,
      );
    }
  });
});

describe("legacy input: resource context and invoice queries", () => {
  const base = "organizationId=o1&ownerType=group&ownerId=g1";
  const context = { organizationId: "o1", ownerType: "group", ownerId: "g1" };

  const contexts: Array<[string, string, boolean]> = [
    ["valid group", base, true],
    ["valid user owner", "organizationId=o1&ownerType=user&ownerId=u1", true],
    ["extra query keys are ignored", `${base}&other=1`, true],
    ["missing organization", "ownerType=group&ownerId=g1", false],
    ["empty organization", "organizationId=&ownerType=group&ownerId=g1", false],
    [
      "unknown owner type",
      "organizationId=o1&ownerType=team&ownerId=g1",
      false,
    ],
    [
      "uppercase owner type",
      "organizationId=o1&ownerType=GROUP&ownerId=g1",
      false,
    ],
    ["empty owner id", "organizationId=o1&ownerType=group&ownerId=", false],
    ["missing owner id", "organizationId=o1&ownerType=group", false],
    ["repeated organization", `${base}&organizationId=o2`, false],
    ["no query", "", false],
  ];

  it.each(contexts)("policies list: %s", async (_label, query, accepted) => {
    const { app, policies } = harness();
    const response = await request(app)
      .get(`/api/v1/business-policies${query ? `?${query}` : ""}`)
      .set("Cookie", COOKIE);

    if (accepted) {
      expect(response.status).toBe(200);
      expect(policies.listPolicies).toHaveBeenCalledOnce();
    } else {
      expectRejected(response);
      expect(policies.listPolicies).not.toHaveBeenCalled();
    }
  });

  const listCases: Array<[string, string, "reject" | unknown]> = [
    ["defaults", base, { q: "", cursor: undefined, limit: 50 }],
    [
      "trims q",
      `${base}&q=%20abc%20`,
      { q: "abc", cursor: undefined, limit: 50 },
    ],
    [
      "q of 120",
      `${base}&q=${long(120)}`,
      { q: long(120), cursor: undefined, limit: 50 },
    ],
    ["q of 121", `${base}&q=${long(121)}`, "reject"],
    [
      "q of 120 plus spaces",
      `${base}&q=${long(120)}%20%20`,
      {
        q: long(120),
        cursor: undefined,
        limit: 50,
      },
    ],
    ["cursor", `${base}&cursor=abc`, { q: "", cursor: "abc", limit: 50 }],
    ["empty cursor", `${base}&cursor=`, "reject"],
    ["limit 1", `${base}&limit=1`, { q: "", cursor: undefined, limit: 1 }],
    [
      "limit 100",
      `${base}&limit=100`,
      { q: "", cursor: undefined, limit: 100 },
    ],
    ["limit 0", `${base}&limit=0`, "reject"],
    ["limit 101", `${base}&limit=101`, "reject"],
    ["limit 1.5", `${base}&limit=1.5`, "reject"],
    ["limit abc", `${base}&limit=abc`, "reject"],
    ["empty limit", `${base}&limit=`, "reject"],
    [
      "limit with spaces",
      `${base}&limit=%205%20`,
      { q: "", cursor: undefined, limit: 5 },
    ],
    [
      "limit exponent",
      `${base}&limit=1e1`,
      { q: "", cursor: undefined, limit: 10 },
    ],
    [
      "limit hex",
      `${base}&limit=0x10`,
      { q: "", cursor: undefined, limit: 16 },
    ],
    ["repeated limit", `${base}&limit=1&limit=2`, "reject"],
    ["repeated q", `${base}&q=a&q=b`, "reject"],
  ];

  it.each(listCases)("invoice list: %s", async (_label, query, expected) => {
    const { app, invoices } = harness();
    const response = await request(app)
      .get(`/api/v1/invoices?${query}`)
      .set("Cookie", COOKIE);

    if (expected === "reject") {
      expectRejected(response);
      expect(invoices.listInvoices).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(invoices.listInvoices).toHaveBeenCalledWith(
        ACTOR,
        context,
        expected,
      );
    }
  });

  it("invoice detail validates with the list rules (limit included)", async () => {
    const { app, invoices } = harness();

    const accepted = await request(app)
      .get(`/api/v1/invoices/i1?${base}`)
      .set("Cookie", COOKIE);
    expect(accepted.status).toBe(200);
    expect(invoices.getInvoice).toHaveBeenCalledWith(ACTOR, context, "i1");

    const rejected = await request(app)
      .get(`/api/v1/invoices/i1?${base}&limit=500`)
      .set("Cookie", COOKIE);
    expectRejected(rejected);
  });

  it("validates queries before the session on invoice and policy reads", async () => {
    const { app } = harness();

    const invoices = await request(app).get("/api/v1/invoices");
    const policies = await request(app).get("/api/v1/business-policies");
    const valid = await request(app).get(`/api/v1/invoices?${base}`);

    expect(invoices.status).toBe(400);
    expect(policies.status).toBe(400);
    expect(valid.status).toBe(401);
  });
});
