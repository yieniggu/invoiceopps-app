import { namedId } from "./test/ids";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parsePage } from "./features/navigation/useListParams";
import { renderApp } from "./test/renderApp";
import {
  NO_PERMISSIONS,
  jsonResponse,
  membership,
  mockTransport,
  pagedList,
  profileFixture,
} from "./test/transport";
import { uuid } from "./test/ids";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// CR-282: a page past the end of a list (a bookmark, a list that shrank) is not
// "no results". Once the answer arrives the URL moves, replacing the entry, to
// the last page that exists, and the false empty copy never shows.

const COUNT = 45; // 3 pages of 20
const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const index = Array.from({ length: COUNT }, (_unused, i) => i);
const person = (i: number) => ({
  id: uuid(i),
  name: `Persona ${String(i).padStart(2, "0")}`,
  rut: `${10_000_000 + i}9`,
});

describe("parsePage", () => {
  it("accepts integers from 1 to the server maximum and falls back to 1", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("7")).toBe(7);
    expect(parsePage("10000")).toBe(10000);
    for (const bad of [
      null,
      "",
      "0",
      "-3",
      "2.5",
      "abc",
      "10001",
      "99999999999",
      "1e9",
    ])
      expect(parsePage(bad), String(bad)).toBe(1);
  });
});

const platform = profileFixture({
  id: "00000000-0000-4000-b000-000000000001",
  isPlatformAdministrator: true,
});
const orgAdmin = profileFixture({ memberships: [membership(north, "ADMIN")] });
const orgUser = profileFixture({ memberships: [membership(north, "USER")] });

const base = (profile: unknown) => ({
  "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
  "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
});

describe("organization directory", () => {
  const routes = () => ({
    ...base(platform),
    "GET /api/v1/organizations": pagedList(
      "organizations",
      index.map((i) => ({
        id: namedId("org", i),
        name: `Organización ${String(i).padStart(2, "0")}`,
        slug: namedId("org", i),
        description: null,
        enabled: true,
        createdAt: "2026-10-01T00:00:00.000Z",
      })),
      ({ id }) => id,
    ),
  });

  it("lands on the last page instead of saying there are no organizations", async () => {
    mockTransport(routes());
    renderApp({ route: "/organizations?page=99" });
    await screen.findByText("Organización 44");
    expect(window.location.search).toBe("?page=3");
    expect(screen.getByText("Página 3 de 3")).toBeTruthy();
    expect(screen.queryByText("Aún no hay organizaciones")).toBeNull();
    expect(
      screen.queryByText("No hay organizaciones que coincidan"),
    ).toBeNull();
  });

  it("treats an invalid or oversized page as the first one", async () => {
    const transport = mockTransport(routes());
    renderApp({ route: "/organizations?page=10001" });
    await screen.findByText("Organización 00");
    for (const request of transport.calls("GET /api/v1/organizations"))
      expect(new URLSearchParams(request.search).get("page")).toBe("1");
  });
});

describe("administration directory", () => {
  const routes = () => ({
    ...base(platform),
    "GET /api/v1/admin/users": pagedList(
      "users",
      index.map((i) => ({
        ...person(i),
        disabledAt: null,
        recentlyActive: false,
      })),
      ({ id }) => id,
    ),
  });

  it("lands on the last page instead of saying no user matches", async () => {
    mockTransport(routes());
    renderApp({ route: "/admin?page=99" });
    await screen.findByRole("link", { name: "Persona 44" });
    expect(window.location.search).toBe("?page=3");
    expect(screen.queryByText("No hay usuarios que coincidan")).toBeNull();
  });

  it("keeps the other filters when it moves to the last page", async () => {
    mockTransport(routes());
    renderApp({ route: "/admin?page=99&status=all&search=Persona" });
    await screen.findByRole("link", { name: "Persona 44" });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("page")).toBe("3");
    expect(params.get("search")).toBe("Persona");
  });

  it("treats an oversized page as the first one", async () => {
    const transport = mockTransport(routes());
    renderApp({ route: "/admin?page=10001" });
    await screen.findByRole("link", { name: "Persona 00" });
    for (const request of transport.calls("GET /api/v1/admin/users"))
      expect(new URLSearchParams(request.search).get("page")).toBe("1");
  });
});

describe("organization members", () => {
  const MEMBERSHIPS =
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships";
  const MEMBERS =
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members";
  const routes = (profile: unknown) => ({
    ...base(profile),
    [MEMBERSHIPS]: pagedList(
      "memberships",
      index.map((i) => ({
        userId: person(i).id,
        organizationId: "00000000-0000-4000-9000-000000000001",
        role: "USER",
        permissions: NO_PERMISSIONS,
        groups: [],
        user: { ...person(i), disabled: false, recentlyActive: false },
      })),
      ({ userId }) => userId,
    ),
    [MEMBERS]: pagedList(
      "members",
      index.map((i) => ({
        userId: person(i).id,
        name: person(i).name,
        email: null,
        recentlyActive: false,
      })),
      ({ userId }) => userId,
    ),
  });

  it("management table: lands on the last page", async () => {
    mockTransport(routes(orgAdmin));
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members?page=99",
    });
    await screen.findByRole("link", { name: "Persona 44" });
    expect(window.location.search).toBe("?page=3");
    expect(
      screen.queryByText("Esta organización no tiene miembros."),
    ).toBeNull();
  });

  it("basic list: lands on the last page", async () => {
    mockTransport(routes(orgUser));
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members?page=99",
    });
    await screen.findByRole("link", { name: "Persona 44" });
    expect(window.location.search).toBe("?page=3");
    expect(
      screen.queryByText("Esta organización no tiene miembros."),
    ).toBeNull();
  });

  it("a truly empty list still says so", async () => {
    mockTransport({
      ...routes(orgAdmin),
      [MEMBERSHIPS]: pagedList("memberships", [], () => ""),
    });
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members?page=2",
    });
    await screen.findByText("Esta organización no tiene miembros.");
    expect(window.location.search).toBe("?page=2");
  });
});

describe("group members", () => {
  const MEMBERS =
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships";
  const routes = () => ({
    ...base(orgAdmin),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () =>
        jsonResponse({
          groups: [
            {
              id: "00000000-0000-4000-a000-000000000097",
              organizationId: "00000000-0000-4000-9000-000000000001",
              name: "Contabilidad",
              description: null,
            },
          ],
        }),
    [MEMBERS]: pagedList(
      "memberships",
      index.map((i) => ({
        userId: person(i).id,
        groupId: "00000000-0000-4000-a000-000000000097",
        organizationId: "00000000-0000-4000-9000-000000000001",
        permissions: NO_PERMISSIONS,
        user: person(i),
      })),
      ({ userId }) => userId,
    ),
  });

  it("lands on the last page instead of saying the group has no members", async () => {
    mockTransport(routes());
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members?page=99",
    });
    await screen.findByRole("link", { name: "Persona 44" });
    await waitFor(() => expect(window.location.search).toBe("?page=3"));
    expect(screen.queryByText(/Este grupo no tiene miembros/)).toBeNull();
  });
});
