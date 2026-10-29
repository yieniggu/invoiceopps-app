import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const me = profileFixture({
  memberships: [
    membership(
      { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
      "USER",
    ),
  ],
});

const routes = (
  user: Record<string, unknown>,
  shared = [
    { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
  ],
) => ({
  "GET /api/v1/auth/profile": () => jsonResponse({ profile: me }),
  "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
  "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
    jsonResponse({
      user: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Carla Soto",
        email: null,
        recentlyActive: false,
        ...user,
      },
      sharedOrganizations: shared,
    }),
});

describe("basic user profile at /users/:userId (AC-17)", () => {
  it("shows name, email, activity and the shared organizations as links to any authenticated user", async () => {
    mockTransport(
      routes({ email: "carla@example.test", recentlyActive: true }),
    );
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const data = screen.getByRole("region", { name: "Datos" });
    expect(data.textContent).toContain("Correocarla@example.test");
    expect(data.textContent).toContain("ActividadActivo");
    expect(
      screen.getByRole("link", { name: "Academia Norte" }).getAttribute("href"),
    ).toBe("/organizations/00000000-0000-4000-9000-000000000001");
    // No administrative data or action on this screen.
    expect(screen.queryByText("RUT")).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });

  it("says «Sin correo» and «Inactivo» when there is no email and no recent activity", async () => {
    mockTransport(routes({}));
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const data = screen.getByRole("region", { name: "Datos" });
    expect(data.textContent).toContain("CorreoSin correo");
    expect(data.textContent).toContain("ActividadInactivo");
  });

  it("answers 404 with the not-found screen", async () => {
    mockTransport({
      ...routes({}),
      "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
        errorResponse(404, "NOT_FOUND"),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Página no encontrada",
    });
  });

  it("offers a retry when the read fails", async () => {
    let calls = 0;
    mockTransport({
      ...routes({}),
      "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () => {
        calls += 1;
        return calls === 1
          ? errorResponse(500, "INTERNAL_ERROR")
          : jsonResponse({
              user: {
                id: "00000000-0000-4000-8000-000000000003",
                name: "Carla Soto",
                email: null,
                recentlyActive: false,
              },
              sharedOrganizations: [],
            });
      },
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar persona" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByText("No compartes organizaciones con esta persona."),
    ).toBeTruthy();
  });

  it("is reached from the reduced member list", async () => {
    mockTransport({
      ...routes({}),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members":
        () =>
          jsonResponse({
            members: [
              {
                userId: "00000000-0000-4000-8000-000000000003",
                name: "Carla Soto",
                email: null,
                recentlyActive: false,
              },
            ],
            page: 1,
            pageSize: 20,
            total: 1,
          }),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    fireEvent.click(await screen.findByRole("link", { name: "Carla Soto" }));
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(window.location.pathname).toBe(
      "/users/00000000-0000-4000-8000-000000000003",
    );
  });
});

describe("platform administrator on /users/:userId (CR-290)", () => {
  const platform = profileFixture({
    id: "00000000-0000-4000-b000-000000000001",
    isPlatformAdministrator: true,
  });
  const asPlatform = (overrides: Record<string, unknown> = {}) => ({
    ...routes({}, []),
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    ...overrides,
  });

  it("speaks of the person's organizations, never of shared ones", async () => {
    mockTransport(asPlatform());
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByRole("heading", { level: 2, name: "Organizaciones" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Esta persona no pertenece a ninguna organización."),
    ).toBeTruthy();
    expect(screen.queryByText(/compart/i)).toBeNull();
  });

  it("lists every organization of the person as links", async () => {
    mockTransport({
      ...asPlatform(),
      ...routes({}, [
        { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
        { id: "00000000-0000-4000-9000-000000000002", name: "Instituto Sur" },
      ]),
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("link", { name: "Instituto Sur" });
    expect(screen.getByRole("link", { name: "Academia Norte" })).toBeTruthy();
    expect(screen.queryByText(/compart/i)).toBeNull();
  });

  it("says the person is not on the platform, not that nothing is shared, on 404", async () => {
    mockTransport(
      asPlatform({
        "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
          errorResponse(404, "NOT_FOUND"),
      }),
    );
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByText("No encontramos a esa persona en la plataforma.");
    expect(screen.queryByText(/comparten organización/)).toBeNull();
  });

  it("keeps the shared-organization copy for everyone else", async () => {
    mockTransport(routes({}, []));
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Organizaciones compartidas",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("No compartes organizaciones con esta persona."),
    ).toBeTruthy();
  });
});
