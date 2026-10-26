import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const onNavigate = vi.fn();
  render(
    <WorkspaceProvider profile={next} groups={[]}>
      <DashboardScreen
        profile={next}
        contextState="loaded"
        onNavigate={onNavigate}
        onRetry={vi.fn()}
      />
    </WorkspaceProvider>,
  );
  return onNavigate;
}

afterEach(cleanup);

describe("DashboardScreen cards", () => {
  it("puts Facturas first and keeps the agreed card order", () => {
    renderDashboard({ ...profile, isPlatformAdministrator: true });
    const titles = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual([
      "Facturas",
      "Tu espacio de trabajo",
      "Políticas",
      "Administración",
    ]);
  });

  it("omits Administración without authority", () => {
    renderDashboard();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Administración" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Ir a administración" }),
    ).toBeNull();
  });

  it("navigates from each card CTA", () => {
    const onNavigate = renderDashboard({
      ...profile,
      isPlatformAdministrator: true,
    });
    for (const [label, destination] of [
      ["Ir a facturas", "Facturas"],
      ["Ver mis organizaciones", "Organizaciones"],
      ["Ver mis grupos", "Mis grupos"],
      ["Ir a políticas", "Políticas"],
      ["Ir a administración", "Administración"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onNavigate).toHaveBeenLastCalledWith(destination);
    }
  });

  it("shows the active context details inside the workspace card", () => {
    renderDashboard();
    const card = screen.getByRole("region", { name: "Tu espacio de trabajo" });
    expect(card.textContent).toContain("Academia");
    expect(card.textContent).toContain("Trabajo individual");
  });
});
