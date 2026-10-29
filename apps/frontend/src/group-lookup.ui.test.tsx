import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

// A group with more members than one page (and an organization with more
// people than one page) must work on every group screen: the table pages, the
// summary counts them all, and the single lookups, the bulk editor and the
// "who is already inside" check ask the server for exactly the ids they need.

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN")],
});
const group = {
  id: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  name: "Contabilidad",
  description: null,
};

const person = (index: number) => ({
  id: uuid(index),
  name: `Persona ${String(index).padStart(3, "0")}`,
  rut: `${10_000_000 + index}9`,
});
const groupMember = (index: number) => ({
  userId: person(index).id,
  groupId: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  permissions: NO_PERMISSIONS,
  user: person(index),
});

const MEMBERS =
  "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships";
const USERS =
  "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users";

/** 150 people in the organization; the first 120 are in the group. */
const PEOPLE = Array.from({ length: 150 }, (_unused, index) => index);
const IN_GROUP = PEOPLE.slice(0, 120);

function server() {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: adminProfile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [group] }),
    [MEMBERS]: pagedList(
      "memberships",
      IN_GROUP.map(groupMember),
      ({ userId }) => userId,
    ),
    [USERS]: pagedList(
      "users",
      PEOPLE.map((index) => ({ ...person(index), role: "USER" })),
      ({ id }) => id,
    ),
  });
}

describe("a group with more than one page of members", () => {
  it("pages the members table and reaches the last page", async () => {
    const transport = server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members",
    });
    await screen.findByRole("link", { name: "Persona 000" });
    expect(screen.getByText("Página 1 de 6")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("link", { name: "Persona 020" });
    expect(window.location.search).toBe("?page=2");
    for (const request of transport.calls(MEMBERS))
      expect(new URLSearchParams(request.search).get("userIds")).toBeNull();
  });

  it("opens the last page straight from a bookmark", async () => {
    server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members?page=6",
    });
    await screen.findByRole("link", { name: "Persona 119" });
    expect(screen.getByText("Página 6 de 6")).toBeTruthy();
  });

  it("counts every member on the summary, not just the first page", async () => {
    server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097",
    });
    const summary = await screen.findByRole("region", { name: "Resumen" });
    await within(summary).findByText("120");
  });

  it("opens a member that is not on the first page, by id", async () => {
    const transport = server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/00000000-0000-4000-8000-000000000110",
    });
    await screen.findByRole("heading", { name: "Persona 110" });
    const lookups = transport.calls(MEMBERS);
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups)
      expect(new URLSearchParams(lookup.search).get("userIds")).toBe(
        "00000000-0000-4000-8000-000000000110",
      );
  });

  it("shows not found for a person that is not in the group", async () => {
    server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/00000000-0000-4000-8000-000000000140",
    });
    await screen.findByText(
      "No encontramos a esa persona entre los miembros del grupo.",
    );
  });

  it("resolves the people of the bulk editor beyond the first page", async () => {
    const transport = server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/permissions?userIds=00000000-0000-4000-8000-000000000110,00000000-0000-4000-8000-000000000115",
    });
    await screen.findByText("Persona 110");
    await screen.findByText("Persona 115");
    for (const lookup of transport.calls(MEMBERS))
      expect(new URLSearchParams(lookup.search).get("userIds")).toBe(
        "00000000-0000-4000-8000-000000000110,00000000-0000-4000-8000-000000000115",
      );
  });

  it("offers the organization members who are not in the group, however far down their page is", async () => {
    const transport = server();
    // 20 people per page: page 1 (0..19) is entirely inside the group, page 7
    // holds 120..139 and page 8 the last 10.
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/new",
    });
    expect(
      await screen.findByText(
        "Todas las personas de esta página ya están en el grupo.",
      ),
    ).toBeTruthy();
    cleanup();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/new?page=8",
    });
    await screen.findByRole("checkbox", { name: /Persona 140/ });
    expect(screen.getAllByRole("checkbox", { name: /Persona/ })).toHaveLength(
      10,
    );
    expect(screen.queryByRole("checkbox", { name: /Persona 110/ })).toBeNull();
    // Only the pages asked for were read (no walk of the organization) and the
    // group was asked by id for the people on those pages alone.
    const pages = transport
      .calls(USERS)
      .map(({ search }) => new URLSearchParams(search).get("page"));
    expect(pages).toEqual(["1", "8"]);
    for (const lookup of transport.calls(MEMBERS))
      expect(
        new URLSearchParams(lookup.search).get("userIds")?.split(",").length,
      ).toBeLessThanOrEqual(20);
  });
});
