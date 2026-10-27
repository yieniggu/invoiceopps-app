import request, { type Response } from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { BusinessPolicyService } from "../../src/business-policies.js";
import type { GroupService } from "../../src/groups.js";
import type { InvoiceService } from "../../src/invoices.js";
import type { PlatformAdministratorService } from "../../src/platform-administrator.js";

// Characterization of the legacy (not yet OpenAPI-documented) input rules:
// exactly which bodies and queries each route accepts, what the service
// receives, and that everything else is a 400 VALIDATION_ERROR. The table
// must pass identically before and after the parsers move to zod schemas.

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";

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
    updateGroup: vi.fn(async () => group),
    addMember: vi.fn(async () => group),
    deleteGroup: vi.fn(async () => {}),
    removeMember: vi.fn(async () => {}),
    listGroups: vi.fn(async () => []),
  };
  const platform = {
    createOrganization: vi.fn(async () => ({ id: "o1" })),
    provisionUser: vi.fn(async () => ({ user: {}, temporaryPassword: "x" })),
    createMembership: vi.fn(async () => ({ id: "m1" })),
    changeMembershipRole: vi.fn(async () => ({ id: "m1" })),
    removeMembership: vi.fn(async () => {}),
    listOrganizations: vi.fn(async () => []),
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
    groups: groups as unknown as GroupService,
    platformAdministrators: platform as unknown as PlatformAdministratorService,
    businessPolicies: policies as unknown as BusinessPolicyService,
    invoices: invoices as unknown as InvoiceService,
  });
  return { app, groups, platform, policies, invoices };
}

const long = (length: number) => "x".repeat(length);

type Case = [label: string, body: unknown, expected: "reject" | unknown];

async function send(
  app: ReturnType<typeof harness>["app"],
  method: "post" | "patch",
  path: string,
  body: unknown,
) {
  const agent = request(app);
  const call = (method === "post" ? agent.post(path) : agent.patch(path))
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE);
  if (body === undefined) return call;
  return call
    .set("Content-Type", "application/json")
    .send(JSON.stringify(body));
}

function expectRejected(response: Response) {
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("VALIDATION_ERROR");
}

describe("legacy input: group create", () => {
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

describe("legacy input: group update", () => {
  const cases: Case[] = [
    ["name", { name: "B" }, { name: "B" }],
    ["trimmed name", { name: " B " }, { name: "B" }],
    ["null description", { description: null }, { description: null }],
    ["trimmed description", { description: " x " }, { description: "x" }],
    [
      "blank description becomes null",
      { description: "  " },
      { description: null },
    ],
    [
      "both fields",
      { name: "B", description: "d" },
      { name: "B", description: "d" },
    ],
    ["empty object", {}, "reject"],
    ["unknown key", { other: 1 }, "reject"],
    ["known plus unknown key", { name: "B", other: 1 }, "reject"],
    ["null name", { name: null }, "reject"],
    ["empty name", { name: "" }, "reject"],
    ["blank name", { name: " " }, "reject"],
    ["name of 120", { name: long(120) }, { name: long(120) }],
    ["name of 121", { name: long(121) }, "reject"],
    ["numeric description", { description: 5 }, "reject"],
    [
      "description of 1000",
      { description: long(1000) },
      { description: long(1000) },
    ],
    ["description of 1001", { description: long(1001) }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, groups } = harness();
    const response = await send(
      app,
      "patch",
      "/api/v1/organizations/o1/groups/g1",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(groups.updateGroup).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(groups.updateGroup).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "g1",
        expected,
      );
    }
  });
});

describe("legacy input: group member", () => {
  const cases: Case[] = [
    ["userId", { userId: "u1" }, "u1"],
    ["trimmed userId", { userId: " u1 " }, "u1"],
    ["empty userId", { userId: "" }, "reject"],
    ["blank userId", { userId: "  " }, "reject"],
    ["numeric userId", { userId: 5 }, "reject"],
    ["extra key", { userId: "u1", x: 1 }, "reject"],
    ["empty object", {}, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, groups } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/organizations/o1/groups/g1/members",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(groups.addMember).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(200);
      expect(groups.addMember).toHaveBeenCalledWith(
        ACTOR,
        "o1",
        "g1",
        expected,
      );
    }
  });
});

describe("legacy input: organization membership", () => {
  const create: Case[] = [
    ["admin", { userId: "u1", role: "ADMIN" }, ["u1", "ADMIN"]],
    ["trimmed userId", { userId: " u1 ", role: "USER" }, ["u1", "USER"]],
    ["unknown role", { userId: "u1", role: "OWNER" }, "reject"],
    ["lowercase role", { userId: "u1", role: "admin" }, "reject"],
    ["missing role", { userId: "u1" }, "reject"],
    ["missing userId", { role: "USER" }, "reject"],
    ["blank userId", { userId: " ", role: "USER" }, "reject"],
    ["numeric userId", { userId: 5, role: "USER" }, "reject"],
    ["extra key", { userId: "u1", role: "USER", x: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(create)("create: %s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/platform/organizations/o1/members",
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
        (expected as string[])[0],
        (expected as string[])[1],
      );
    }
  });

  const change: Case[] = [
    ["role only", { role: "USER" }, "USER"],
    ["with userId", { role: "USER", userId: "u2" }, "reject"],
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
      "/api/v1/platform/organizations/o1/members/u1",
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

describe("legacy input: organization create", () => {
  const cases: Case[] = [
    [
      "name and slug",
      { name: "Org", slug: "org-1" },
      { name: "Org", slug: "org-1" },
    ],
    [
      "trims name, keeps slug",
      { name: " Org ", slug: "org" },
      { name: "Org", slug: "org" },
    ],
    [
      "description trimmed",
      { name: "Org", slug: "org", description: " d " },
      { name: "Org", slug: "org", description: "d" },
    ],
    [
      "blank description becomes null",
      { name: "Org", slug: "org", description: " " },
      { name: "Org", slug: "org", description: null },
    ],
    [
      "null description",
      { name: "Org", slug: "org", description: null },
      { name: "Org", slug: "org", description: null },
    ],
    ["uppercase slug", { name: "Org", slug: "Org" }, "reject"],
    ["double dash slug", { name: "Org", slug: "a--b" }, "reject"],
    ["leading dash slug", { name: "Org", slug: "-a" }, "reject"],
    ["trailing dash slug", { name: "Org", slug: "a-" }, "reject"],
    ["empty slug", { name: "Org", slug: "" }, "reject"],
    ["padded slug", { name: "Org", slug: " org" }, "reject"],
    ["numeric slug", { name: "Org", slug: 5 }, "reject"],
    ["missing slug", { name: "Org" }, "reject"],
    ["blank name", { name: " ", slug: "org" }, "reject"],
    ["name of 121", { name: long(121), slug: "org" }, "reject"],
    [
      "description of 1001",
      { name: "Org", slug: "org", description: long(1001) },
      "reject",
    ],
    [
      "numeric description",
      { name: "Org", slug: "org", description: 1 },
      "reject",
    ],
    ["extra key", { name: "Org", slug: "org", x: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(
      app,
      "post",
      "/api/v1/platform/organizations",
      body,
    );

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.createOrganization).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(platform.createOrganization).toHaveBeenCalledWith(ACTOR, expected);
    }
  });
});

describe("legacy input: user provisioning", () => {
  const valid = {
    name: " Ada ",
    rut: "12.345.678-5",
    organizationId: " o1 ",
    role: "USER",
  };
  const cases: Case[] = [
    [
      "canonicalizes RUT and trims",
      valid,
      { name: "Ada", rut: "123456785", organizationId: "o1", role: "USER" },
    ],
    ["invalid RUT", { ...valid, rut: "11.111.111-2" }, "reject"],
    ["numeric RUT", { ...valid, rut: 123456785 }, "reject"],
    [
      "missing RUT",
      { name: "Ada", organizationId: "o1", role: "USER" },
      "reject",
    ],
    ["unknown role", { ...valid, role: "OWNER" }, "reject"],
    ["blank organization", { ...valid, organizationId: " " }, "reject"],
    ["numeric organization", { ...valid, organizationId: 5 }, "reject"],
    ["blank name", { ...valid, name: " " }, "reject"],
    ["name of 121", { ...valid, name: long(121) }, "reject"],
    ["extra key", { ...valid, x: 1 }, "reject"],
    ["array body", [], "reject"],
    ["no body", undefined, "reject"],
  ];

  it.each(cases)("%s", async (_label, body, expected) => {
    const { app, platform } = harness();
    const response = await send(app, "post", "/api/v1/platform/users", body);

    if (expected === "reject") {
      expectRejected(response);
      expect(platform.provisionUser).not.toHaveBeenCalled();
    } else {
      expect(response.status).toBe(201);
      expect(platform.provisionUser).toHaveBeenCalledWith(ACTOR, expected);
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
