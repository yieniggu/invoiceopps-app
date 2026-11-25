import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fromApiRut } from "./lib/rut";
import { renderApp } from "./test/renderApp";
import {
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const orgA = { id: "00000000-0000-4000-9000-00000000000a", name: "Academia A" };
const orgB = { id: "00000000-0000-4000-9000-00000000000b", name: "Academia B" };

async function open(overrides: Record<string, unknown> = {}) {
  mockTransport({
    "GET /api/v1/auth/profile": () =>
      jsonResponse({ profile: profileFixture(overrides) }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
  });
  renderApp({ route: "/profile" });
  return screen.findByRole("heading", { level: 1, name: "Mi perfil" });
}

describe("profile header", () => {
  it("AC-07 shows name and RUT as one line and no identity section", async () => {
    const title = await open();
    const header = title.closest("header") as HTMLElement;
    expect(header.querySelector(".page-description")?.textContent).toBe(
      `Ada Lovelace · ${fromApiRut("123456785")}`,
    );
    expect(screen.queryByRole("region", { name: "Identidad" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Identidad" })).toBeNull();
    expect(
      screen.queryByText(/Datos de identificación registrados/),
    ).toBeNull();
    expect(screen.queryByText("Administrador de plataforma")).toBeNull();
  });

  it("AC-07 shows the platform administrator badge beside the title", async () => {
    const title = await open({ isPlatformAdministrator: true });
    const badge = screen.getByText("Administrador de plataforma");
    expect(badge.className).toContain("role-badge");
    expect(title.parentElement?.contains(badge)).toBe(true);
  });

  it("AC-08 names the contact form Cuenta", async () => {
    await open();
    expect(
      screen.getByRole("heading", { level: 2, name: "Cuenta" }),
    ).toBeTruthy();
    expect(screen.queryByText("Datos de contacto")).toBeNull();
  });
});

describe("profile organizations", () => {
  it("AC-09 lists one row per membership with role and group chips, unlinked", async () => {
    await open({
      memberships: [
        membership(orgA, "ADMIN", {
          groups: [
            {
              group: {
                id: "00000000-0000-4000-8000-0000000000c1",
                name: "Contabilidad",
              },
            },
            {
              group: {
                id: "00000000-0000-4000-8000-0000000000c2",
                name: "Ventas",
              },
            },
          ],
        }),
        membership(orgB, "USER"),
      ],
    });
    const region = await screen.findByRole("region", {
      name: "Organizaciones",
    });
    const rows = within(region).getAllByRole("listitem", {
      // Only the organization rows, not the group chips.
      name: (_, element) => element.parentElement?.className === "org-list",
    });
    expect(rows).toHaveLength(2);

    const [first, second] = rows;
    expect(within(first).getByText("Academia A")).toBeTruthy();
    expect(within(first).getByText("Administrador")).toBeTruthy();
    const chips = within(first).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Contabilidad",
      "Ventas",
    ]);

    expect(within(second).getByText("Academia B")).toBeTruthy();
    expect(within(second).getByText("Sin grupos")).toBeTruthy();
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
  });

  it("AC-09 says so in one line when there are no organizations", async () => {
    await open();
    const region = await screen.findByRole("region", {
      name: "Organizaciones",
    });
    expect(
      within(region).getAllByText("No tienes organizaciones asignadas."),
    ).toHaveLength(1);
    expect(within(region).queryByRole("list")).toBeNull();
  });
});
