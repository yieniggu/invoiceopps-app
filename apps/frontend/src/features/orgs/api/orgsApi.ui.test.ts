import { afterEach, describe, expect, it, vi } from "vitest";

import {
  orgMembersKey,
  orgMembershipsKey,
  orgsKey,
  userBasicKey,
} from "../../auth/session/queryKeys";
import {
  jsonResponse,
  mockTransport,
  orgMembershipsPage,
  organizationsPage,
  pageEnvelope,
} from "../../../test/transport";
import {
  getUserBasic,
  listMemberships,
  listOrganizationMembers,
  listOrganizations,
  updateOrganization,
} from "./orgsApi";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paginated organization API (B3c S3)", () => {
  it("lists organizations with the page, pageSize and search in the query", async () => {
    const transport = mockTransport({
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });
    const page = await listOrganizations({
      page: 2,
      pageSize: 50,
      search: "norte",
    });
    expect(page).toEqual({
      organizations: [],
      page: 1,
      pageSize: 100,
      total: 0,
    });
    expect(transport.requests[0]?.search).toBe(
      "?page=2&pageSize=50&search=norte",
    );
  });

  it("asks for the largest first page by default and omits an undefined search", async () => {
    const transport = mockTransport({
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });
    await listOrganizations();
    expect(transport.requests[0]?.search).toBe("?page=1&pageSize=100");
  });

  it("reads the memberships envelope with the user status fields", async () => {
    const member = {
      userId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-9000-000000000001",
      role: "ADMIN",
      permissions: {},
      groups: [],
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Ada",
        rut: "123456785",
      },
    };
    const transport = mockTransport({
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () => jsonResponse(orgMembershipsPage([member])),
    });
    const page = await listMemberships("00000000-0000-4000-9000-000000000001", {
      page: 3,
      pageSize: 10,
    });
    expect(transport.requests[0]?.search).toBe("?page=3&pageSize=10");
    expect(page.total).toBe(1);
    expect(page.memberships[0]?.user).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Ada",
      rut: "123456785",
      disabled: false,
      recentlyActive: false,
    });
  });

  it("lists the reduced members of an organization", async () => {
    // A raw spy, not the mock transport: the id is not a UUID on purpose, to
    // pin that the client encodes what it puts in the path.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          pageEnvelope("members", [
            { userId: "u", name: "Ada", email: null, recentlyActive: true },
          ]),
        ),
      );
    const page = await listOrganizationMembers("org/1");
    expect(page.members).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/v1/organizations/org%2F1/members?page=1&pageSize=100",
    );
  });

  it("reads the basic view of a user", async () => {
    mockTransport({
      "GET /api/v1/users/00000000-0000-4000-8000-000000000002": () =>
        jsonResponse({
          user: {
            id: "00000000-0000-4000-8000-000000000002",
            name: "Grace",
            email: null,
            recentlyActive: false,
          },
          sharedOrganizations: [
            { id: "00000000-0000-4000-9000-000000000001", name: "Norte" },
          ],
        }),
    });
    const result = await getUserBasic("00000000-0000-4000-8000-000000000002");
    expect(result.sharedOrganizations).toEqual([
      { id: "00000000-0000-4000-9000-000000000001", name: "Norte" },
    ]);
  });

  it("patches an organization with only the sent fields and returns it", async () => {
    const transport = mockTransport({
      "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
        jsonResponse({
          organization: {
            id: "00000000-0000-4000-9000-000000000001",
            name: "Nuevo",
            slug: "norte",
            description: null,
          },
        }),
    });
    const organization = await updateOrganization(
      "00000000-0000-4000-9000-000000000001",
      {
        name: "Nuevo",
        description: null,
      },
    );
    expect(transport.requests[0]?.body).toEqual({
      name: "Nuevo",
      description: null,
    });
    expect(organization.slug).toBe("norte");
  });
});

describe("identity partitioned query keys with page params", () => {
  const page = { page: 1, pageSize: 100 };

  it("keeps the unparameterized key as the prefix of every page", () => {
    expect(orgsKey("u1")).toEqual(["identity", "u1", "orgs"]);
    expect(orgsKey("u1", page).slice(0, 3)).toEqual(orgsKey("u1"));
    expect(orgMembershipsKey("u1", "o1").slice()).toEqual([
      "identity",
      "u1",
      "org",
      "o1",
      "memberships",
    ]);
    expect(orgMembershipsKey("u1", "o1", page).slice(0, 5)).toEqual(
      orgMembershipsKey("u1", "o1"),
    );
    expect(orgMembersKey("u1", "o1", page).slice(0, 5)).toEqual(
      orgMembersKey("u1", "o1"),
    );
  });

  it("separates pages, organizations, identities and the two member lists", () => {
    expect(orgsKey("u1", page)).not.toEqual(
      orgsKey("u1", { ...page, page: 2 }),
    );
    expect(orgsKey("u1", page)).not.toEqual(orgsKey("u2", page));
    expect(orgMembersKey("u1", "o1")).not.toEqual(
      orgMembershipsKey("u1", "o1"),
    );
  });

  it("keys the basic user under the identity", () => {
    expect(userBasicKey("u1", "u2")).toEqual([
      "identity",
      "u1",
      "user",
      "u2",
      "basic",
    ]);
  });
});
