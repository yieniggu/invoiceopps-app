import { membership } from "../../test/transport";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import type { Profile } from "../profile/ProfileScreen";
import { DashboardScreen } from "./DashboardScreen";

const profile: Profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Ada",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  memberships: [
    membership(
      {
        id: "00000000-0000-4000-9000-000000000001",
        name: "Academia",
        slug: "academia",
      },
      "USER",
    ),
  ],
};

function renderDashboard(next: Profile = profile) {
  render(
    <MemoryRouter>
      <WorkspaceProvider profile={next} groups={[]}>
        <DashboardScreen
          profile={next}
          contextState="loaded"
          onRetry={vi.fn()}
        />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("DashboardScreen cards", () => {
  it("puts Facturas first and keeps the agreed card order", () => {
    renderDashboard({ ...profile, isPlatformAdministrator: true });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(["Facturas", "Tu espacio de trabajo", "Políticas"]);
  });

  it("has no Administración card: people and groups live in Organizaciones and Grupos", () => {
    renderDashboard({ ...profile, isPlatformAdministrator: true });
    expect(
      screen.queryByRole("heading", { level: 2, name: "Administración" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Ir a administración" }),
    ).toBeNull();
  });

  it("links each card CTA to its URL", () => {
    renderDashboard();
    for (const [label, path] of [
      ["Ir a facturas", "/invoices"],
      ["Ver mis organizaciones", "/organizations"],
      ["Ver mis grupos", "/groups"],
    ]) {
      expect(
        screen.getByRole("link", { name: label }).getAttribute("href"),
      ).toBe(path);
    }
  });

  it("shows the Políticas card as coming soon, without a link", () => {
    renderDashboard();
    const card = screen.getByRole("region", { name: "Políticas" });
    expect(card.textContent).toContain("Próximamente");
    expect(screen.queryByRole("link", { name: /políticas/i })).toBeNull();
  });

  it("shows the active context details inside the workspace card", () => {
    renderDashboard();
    const card = screen.getByRole("region", { name: "Tu espacio de trabajo" });
    expect(card.textContent).toContain("Academia");
    expect(card.textContent).toContain("Trabajo individual");
  });
});
