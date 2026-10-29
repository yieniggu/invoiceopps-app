import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { uuid } from "./test/ids";
import { renderApp } from "./test/renderApp";
import {
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
  usersPage,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const accounting = {
  id: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  name: "Contabilidad",
  description: null,
};
const admin = profileFixture({ memberships: [membership(north, "ADMIN")] });

function routes() {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [accounting] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
      () => jsonResponse(usersPage([])),
  };
}

const notFound = () =>
  screen.findByRole("heading", { level: 1, name: "Página no encontrada" });
const byIdsRequests = (
  transport: ReturnType<typeof mockTransport>,
  pattern: RegExp,
) =>
  transport.requests.filter(
    ({ path, search }) => pattern.test(path) && search.includes("userIds="),
  );

describe("a malformed :userId in the route (CR-297)", () => {
  it("shows not found on the group member screen without calling the API", async () => {
    const transport = mockTransport(routes());
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/user-110",
    });
    expect(await notFound()).toBeTruthy();
    expect(
      screen.getByText(
        "No encontramos a esa persona entre los miembros del grupo.",
      ),
    ).toBeTruthy();
    expect(byIdsRequests(transport, /memberships$/)).toEqual([]);
  });

  it("shows not found on the organization member screen without calling the API", async () => {
    const transport = mockTransport(routes());
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/user-110",
    });
    expect(await notFound()).toBeTruthy();
    expect(
      screen.getByText(
        "No encontramos a esa persona entre los miembros de la organización.",
      ),
    ).toBeTruthy();
    expect(byIdsRequests(transport, /memberships$/)).toEqual([]);
  });

  it("still asks for a well-formed id", async () => {
    const transport = mockTransport({
      ...routes(),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () =>
          jsonResponse({ memberships: [], page: 1, pageSize: 100, total: 0 }),
    });
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000110",
    });
    await notFound();
    expect(byIdsRequests(transport, /memberships$/)).toHaveLength(1);
  });
});

describe("route ids that are not UUIDs (CR-306)", () => {
  const platform = profileFixture({
    isPlatformAdministrator: true,
    memberships: [],
  });
  // The shell always reads the profile and the workspace group catalogue; the
  // rest is what the screen asked for.
  const apiRequests = (transport: ReturnType<typeof mockTransport>) =>
    transport.requests.filter(
      ({ path }) =>
        path !== "/api/v1/auth/profile" && path !== "/api/v1/groups",
    );

  it.each([
    ["the organization summary", "/organizations/org-1"],
    ["the organization members", "/organizations/org-1/members"],
    ["the organization edit form", "/organizations/org-1/edit"],
    ["the organization groups", "/organizations/org-1/groups"],
  ])(
    "shows not found on %s for the platform administrator without calling the API",
    async (_label, route) => {
      const transport = mockTransport({
        "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
      });
      renderApp({ route });
      expect(await notFound()).toBeTruthy();
      expect(apiRequests(transport)).toEqual([]);
    },
  );

  it("shows not found for a malformed group id without asking for the groups", async () => {
    const transport = mockTransport(routes());
    renderApp({
      route: `/organizations/${north.id}/groups/group-a`,
    });
    expect(await notFound()).toBeTruthy();
    expect(apiRequests(transport)).toEqual([]);
  });

  it("shows not found for a malformed group id on the group member screens", async () => {
    const transport = mockTransport(routes());
    renderApp({
      route: `/organizations/${north.id}/groups/group-a/members/${uuid(5)}`,
    });
    expect(await notFound()).toBeTruthy();
    expect(apiRequests(transport)).toEqual([]);
  });

  it("shows not found on the platform user screen without calling the API", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    });
    renderApp({ route: "/admin/users/user-1" });
    expect(await notFound()).toBeTruthy();
    expect(apiRequests(transport)).toEqual([]);
  });

  it("shows not found on the user profile screen without calling the API", async () => {
    const transport = mockTransport(routes());
    renderApp({ route: "/users/user-1" });
    expect(await notFound()).toBeTruthy();
    expect(apiRequests(transport)).toEqual([]);
  });
});
