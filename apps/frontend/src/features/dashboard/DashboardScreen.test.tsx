import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import type { Profile } from "../profile/ProfileScreen";
import { DashboardScreen } from "./DashboardScreen";

const profile: Profile = {
  id: "user-1",
  name: "Ada",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  memberships: [
    {
      organization: { id: "org-1", name: "Academia", slug: "academia" },
      role: "USER",
    },
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
      ["Ir a facturas", "/facturas"],
      ["Ver mis organizaciones", "/organizaciones"],
      ["Ver mis grupos", "/grupos"],
      ["Ir a políticas", "/politicas"],
    ]) {
      expect(
        screen.getByRole("link", { name: label }).getAttribute("href"),
      ).toBe(path);
    }
  });

  it("shows the active context details inside the workspace card", () => {
    renderDashboard();
    const card = screen.getByRole("region", { name: "Tu espacio de trabajo" });
    expect(card.textContent).toContain("Academia");
    expect(card.textContent).toContain("Trabajo individual");
  });
});
