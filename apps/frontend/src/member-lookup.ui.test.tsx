import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  NO_PERMISSIONS,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";
import { uuid } from "./test/ids";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The member screen and the bulk editor look people up by id. An organization
// with more members than one page must still resolve member #101 and beyond,
// so they ask the server for exactly the ids they need.

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN")],
});

const person = (index: number) => ({
  id: uuid(index),
  name: `Persona ${String(index).padStart(3, "0")}`,
  rut: `${10_000_000 + index}9`,
});
const orgMember = (index: number) => ({
  userId: person(index).id,
  organizationId: "00000000-0000-4000-9000-000000000001",
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [],
  user: { ...person(index), disabled: false, recentlyActive: false },
});
const MEMBERS = Array.from({ length: 150 }, (_unused, index) =>
  orgMember(index),
);

/** A server holding 150 members that pages like the real one. */
function server() {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: adminProfile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
      ({ search }) => {
        const query = new URLSearchParams(search);
        const ids = query.get("userIds")?.split(",");
        const page = Number(query.get("page") ?? 1);
        const pageSize = Number(query.get("pageSize") ?? 20);
        const matching = ids
          ? MEMBERS.filter((member) => ids.includes(member.userId))
          : MEMBERS;
        return jsonResponse({
          memberships: matching.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: matching.length,
        });
      },
  });
}

describe("people looked up by id", () => {
  it("opens a member that is not on the first page", async () => {
    const transport = server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000120",
    });
    await screen.findByRole("heading", { name: "Persona 120" });
    const lookups = transport.calls(
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) {
      expect(new URLSearchParams(lookup.search).get("userIds")).toBe(
        "00000000-0000-4000-8000-000000000120",
      );
    }
  });

  it("shows not found for an id the server does not list", async () => {
    server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000999",
    });
    await screen.findByText(
      "No encontramos a esa persona entre los miembros de la organización.",
    );
  });

  it("resolves the people of the bulk editor beyond the first page", async () => {
    const transport = server();
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=00000000-0000-4000-8000-000000000120,00000000-0000-4000-8000-000000000140",
    });
    await screen.findByText("Persona 120");
    await screen.findByText("Persona 140");
    for (const lookup of transport.calls(
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
    )) {
      expect(new URLSearchParams(lookup.search).get("userIds")).toBe(
        "00000000-0000-4000-8000-000000000120,00000000-0000-4000-8000-000000000140",
      );
    }
  });
});
