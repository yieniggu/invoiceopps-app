import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  groupMembershipsPage,
  jsonResponse,
  membership,
  mockTransport,
  organizationsPage,
  profileFixture,
  usersPage,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const org = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
  slug: "norte",
};
const group = {
  id: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  name: "Contabilidad",
  description: null,
};
const ada = profileFixture({
  isPlatformAdministrator: true,
  memberships: [membership(org, "ADMIN")],
});
const bruno = profileFixture({
  id: "00000000-0000-4000-8000-000000000002",
  name: "Bruno Díaz",
  rut: "111111111",
  memberships: [
    membership(
      { id: "00000000-0000-4000-9000-000000000002", name: "Instituto Sur" },
      "USER",
    ),
  ],
});

/** Everything any route of the app may read, answered with valid empty data. */
function appRoutes(profile: () => Response | Promise<Response>) {
  return {
    "GET /api/v1/auth/profile": profile,
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    // AC-15: the platform administrator's /organizations lists every
    // organization, so the fixture carries the one the tests open.
    "GET /api/v1/organizations": () =>
      jsonResponse(
        organizationsPage([
          {
            ...org,
            description: null,
            enabled: true,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ]),
      ),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
      jsonResponse({
        organization: { ...org, description: null },
        summary: { memberCount: 1, groupCount: 1 },
      }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [group] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
      () => jsonResponse({ memberships: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
      () => jsonResponse(usersPage([])),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships":
      () => jsonResponse(groupMembershipsPage([])),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000002/groups":
      () => jsonResponse({ groups: [] }),
    "GET /api/v1/invoices": () =>
      jsonResponse({ invoices: [], nextCursor: null }),
    "GET /api/v1/business-policies": () => jsonResponse({ policies: [] }),
  };
}

describe("deep links", () => {
  it.each([
    ["/dashboard", "Panel principal"],
    ["/invoices", "Facturas"],
    ["/policies", "Políticas"],
    ["/profile", "Mi perfil"],
    ["/organizations", "Organizaciones"],
    ["/organizations/new", "Crear organización"],
    ["/organizations/00000000-0000-4000-9000-000000000001", "Academia Norte"],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/groups",
      "Grupos de la organización",
    ],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/groups/new",
      "Crear grupo",
    ],
    ["/organizations/00000000-0000-4000-9000-000000000001/members", "Miembros"],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/members/new",
      "Agregar miembro",
    ],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097",
      "Contabilidad",
    ],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members",
      "Miembros del grupo",
    ],
    [
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/new",
      "Agregar miembros al grupo",
    ],
    ["/groups", "Grupos"],
    ["/admin/users/new", "Crear usuario"],
  ])("opens %s on the %s screen", async (route, title) => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route });
    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(route);
  });

  it.each([
    "/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000003",
    "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/permissions?userIds=00000000-0000-4000-8000-000000000001",
  ])(
    "opens the bulk permissions deep link %s and keeps its query on a reload",
    async (route) => {
      mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
      const first = renderApp({ route });
      await screen.findByRole("heading", {
        level: 1,
        name: "Editar permisos en bloque",
      });
      first.unmount();
      render(<App />);
      await screen.findByRole("heading", {
        level: 1,
        name: "Editar permisos en bloque",
      });
      expect(window.location.pathname + window.location.search).toBe(route);
    },
  );

  it("shows 'No disponible por ahora.' on /policies without reading any policy", async () => {
    const transport = mockTransport(
      appRoutes(() => jsonResponse({ profile: ada })),
    );
    renderApp({ route: "/policies" });
    await screen.findByRole("heading", { level: 1, name: "Políticas" });
    expect(screen.getByText("No disponible por ahora.")).toBeTruthy();
    expect(
      transport.requests.some(({ path }) =>
        path.startsWith("/api/v1/business-policies"),
      ),
    ).toBe(false);
    // The sidebar item is disabled: labelled, with a badge, and not a link.
    const nav = screen.getByRole("navigation", {
      name: "Navegación principal",
    });
    expect(within(nav).queryByRole("link", { name: /Políticas/ })).toBeNull();
    const item = within(nav).getByRole("button", {
      name: "Políticas Próximamente",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    "/panel",
    "/facturas",
    "/politicas",
    "/perfil",
    "/cambiar-contrasena",
    "/organizaciones",
    "/organizaciones/nueva",
    "/organizaciones/00000000-0000-4000-9000-000000000001/grupos",
    "/grupos",
    "/admin/usuarios/nuevo",
  ])(
    "does not redirect the old Spanish path %s: it is not found",
    async (route) => {
      mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
      renderApp({ route });
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Página no encontrada",
        }),
      ).toBeTruthy();
      expect(window.location.pathname).toBe(route);
    },
  );

  it("redirects / to the panel", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/" });
    await screen.findByRole("heading", { level: 1, name: "Panel principal" });
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("keeps the screen after a reload of a deep link", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    const first = renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/groups",
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Grupos de la organización",
    });
    first.unmount();
    // A reload re-creates the app at the URL the browser still holds.
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Grupos de la organización",
      }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/groups",
    );
  });

  it("answers an unknown path with a not-found screen that links back to the panel", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/no-existe" });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("link", { name: "Ir al panel principal" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("sidebar navigation", () => {
  it("changes the URL and marks the active destination", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/dashboard" });
    const nav = await screen.findByRole("navigation", {
      name: "Navegación principal",
    });
    fireEvent.click(within(nav).getByRole("link", { name: "Grupos" }));
    await screen.findByRole("heading", { level: 1, name: "Grupos" });
    expect(window.location.pathname).toBe("/groups");
    expect(
      within(nav)
        .getByRole("link", { name: "Grupos" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "Panel principal" })
        .hasAttribute("aria-current"),
    ).toBe(false);
    // A nested URL keeps its section active.
    fireEvent.click(within(nav).getByRole("link", { name: "Organizaciones" }));
    fireEvent.click(
      await screen.findByRole("link", {
        name: "Ver detalle de Academia Norte",
      }),
    );
    await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
    expect(
      within(nav)
        .getByRole("link", { name: "Organizaciones" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("marks Grupos, not Organizaciones, on an organization's group screens", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/groups",
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Grupos de la organización",
    });
    const nav = screen.getByRole("navigation", {
      name: "Navegación principal",
    });
    expect(
      within(nav)
        .getByRole("link", { name: "Grupos" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      within(nav)
        .getByRole("link", { name: "Organizaciones" })
        .hasAttribute("aria-current"),
    ).toBe(false);
  });
});

describe("onboarding and anonymous access", () => {
  it("blocks every route except the password change while the password is temporary", async () => {
    const pending = profileFixture({
      mustChangePassword: true,
      memberships: [membership(org, "ADMIN")],
    });
    const transport = mockTransport(
      appRoutes(() => jsonResponse({ profile: pending })),
    );
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/groups",
    });
    await screen.findByRole("heading", {
      name: "Cambia tu contraseña temporal",
    });
    expect(window.location.pathname).toBe("/change-password");
    expect(screen.queryByRole("navigation")).toBeNull();
    // Nothing of the blocked route was requested.
    expect(
      transport.requests.filter(({ path }) => path.includes("/groups")),
    ).toEqual([]);
  });

  it("sends a settled person away from the password-change URL", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/change-password" });
    await screen.findByRole("heading", { level: 1, name: "Panel principal" });
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("shows the login on any URL and returns to that URL after signing in", async () => {
    let signedIn = false;
    mockTransport({
      ...appRoutes(() =>
        signedIn
          ? jsonResponse({ profile: ada })
          : errorResponse(401, "UNAUTHENTICATED"),
      ),
      "POST /api/v1/auth/login": () => {
        signedIn = true;
        return jsonResponse({ user: {} });
      },
    });
    renderApp({ route: "/organizations" });
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "test-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Organizaciones" }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/organizations");
  });
});

describe("leaving the session", () => {
  function signInAs(rut: string) {
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: rut },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "test-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
  }

  it("a voluntary logout goes to the panel URL, clears the partition and does not claim an expired session", async () => {
    let current: "ada" | "bruno" | null = "ada";
    mockTransport({
      ...appRoutes(() =>
        current === "ada"
          ? jsonResponse({ profile: ada })
          : current === "bruno"
            ? jsonResponse({ profile: bruno })
            : errorResponse(401, "UNAUTHENTICATED"),
      ),
      "POST /api/v1/auth/logout": () => {
        current = null;
        return new Response(null, { status: 204 });
      },
      "POST /api/v1/auth/login": () => {
        current = "bruno";
        return jsonResponse({ user: {} });
      },
    });
    const { store } = renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001",
    });
    await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
    const adaClient = store.getSnapshot().client;

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(window.location.pathname).toBe("/dashboard");
    expect(
      screen.queryByText("Tu sesión no está disponible o expiró."),
    ).toBeNull();
    expect(screen.getByText("Ingresa con tu RUT y contraseña.")).toBeTruthy();
    expect(adaClient.getQueryCache().getAll()).toHaveLength(0);

    // The next person never sees the previous person's screen.
    signInAs("111111111");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeTruthy();
    expect(screen.queryByText("Academia Norte")).toBeNull();
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("an expired session (401) does say so, and also leaves the previous URL", async () => {
    let expired = false;
    mockTransport(
      appRoutes(() =>
        expired
          ? errorResponse(401, "UNAUTHENTICATED")
          : jsonResponse({ profile: ada }),
      ),
    );
    renderApp({ route: "/organizations/00000000-0000-4000-9000-000000000001" });
    await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
    expired = true;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await screen.findByText("Tu sesión no está disponible o expiró."),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("another person answering the profile resets the URL to the panel", async () => {
    let answer = ada;
    mockTransport(appRoutes(() => jsonResponse({ profile: answer })));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/groups",
    });
    await screen.findByRole("heading", {
      level: 1,
      name: "Grupos de la organización",
    });
    answer = bruno;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Panel principal" }),
    ).toBeTruthy();
    expect(screen.queryByText("Contabilidad")).toBeNull();
    expect(window.location.pathname).toBe("/dashboard");
  });
});
