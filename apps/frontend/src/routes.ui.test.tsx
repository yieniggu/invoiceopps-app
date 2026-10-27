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
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const org = { id: "org-1", name: "Academia Norte", slug: "norte" };
const none = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const group = {
  id: "group-a",
  organizationId: "org-1",
  name: "Contabilidad",
  description: null,
  permissions: none,
};
const ada = profileFixture({
  isPlatformAdministrator: true,
  memberships: [membership(org, "ADMIN")],
});
const bruno = profileFixture({
  id: "user-2",
  name: "Bruno Díaz",
  rut: "111111111",
  memberships: [membership({ id: "org-2", name: "Instituto Sur" }, "USER")],
});

/** Everything any route of the app may read, answered with valid empty data. */
function appRoutes(profile: () => Response | Promise<Response>) {
  return {
    "GET /api/v1/auth/profile": profile,
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": () => jsonResponse({ organizations: [] }),
    "GET /api/v1/organizations/org-1/groups": () =>
      jsonResponse({ groups: [group] }),
    "GET /api/v1/organizations/org-1/memberships": () =>
      jsonResponse({ memberships: [] }),
    "GET /api/v1/organizations/org-1/users": () => jsonResponse({ users: [] }),
    "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
      jsonResponse({ memberships: [] }),
    "GET /api/v1/organizations/org-2/groups": () =>
      jsonResponse({ groups: [] }),
    "GET /api/v1/invoices": () =>
      jsonResponse({ invoices: [], nextCursor: null }),
    "GET /api/v1/business-policies": () => jsonResponse({ policies: [] }),
  };
}

describe("deep links", () => {
  it.each([
    ["/panel", "Panel principal"],
    ["/facturas", "Facturas"],
    ["/politicas", "Políticas"],
    ["/perfil", "Mi perfil"],
    ["/organizaciones", "Organizaciones"],
    ["/organizaciones/nueva", "Crear organización"],
    ["/organizaciones/org-1", "Academia Norte"],
    ["/organizaciones/org-1/grupos", "Grupos de la organización"],
    ["/organizaciones/org-1/grupos/nuevo", "Crear grupo"],
    ["/organizaciones/org-1/grupos/group-a", "Contabilidad"],
    ["/grupos", "Grupos"],
  ])("opens %s on the %s screen", async (route, title) => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route });
    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(route);
  });

  it("redirects / to the panel", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/" });
    await screen.findByRole("heading", { level: 1, name: "Panel principal" });
    expect(window.location.pathname).toBe("/panel");
  });

  it("keeps the screen after a reload of a deep link", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    const first = renderApp({ route: "/organizaciones/org-1/grupos" });
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
    expect(window.location.pathname).toBe("/organizaciones/org-1/grupos");
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
    expect(window.location.pathname).toBe("/panel");
  });
});

describe("sidebar navigation", () => {
  it("changes the URL and marks the active destination", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/panel" });
    const nav = await screen.findByRole("navigation", {
      name: "Navegación principal",
    });
    fireEvent.click(within(nav).getByRole("link", { name: "Grupos" }));
    await screen.findByRole("heading", { level: 1, name: "Grupos" });
    expect(window.location.pathname).toBe("/grupos");
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
    renderApp({ route: "/organizaciones/org-1/grupos" });
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
    renderApp({ route: "/organizaciones/org-1/grupos" });
    await screen.findByRole("heading", {
      name: "Cambia tu contraseña temporal",
    });
    expect(window.location.pathname).toBe("/cambiar-contrasena");
    expect(screen.queryByRole("navigation")).toBeNull();
    // Nothing of the blocked route was requested.
    expect(
      transport.requests.filter(({ path }) => path.includes("/groups")),
    ).toEqual([]);
  });

  it("sends a settled person away from the password-change URL", async () => {
    mockTransport(appRoutes(() => jsonResponse({ profile: ada })));
    renderApp({ route: "/cambiar-contrasena" });
    await screen.findByRole("heading", { level: 1, name: "Panel principal" });
    expect(window.location.pathname).toBe("/panel");
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
    renderApp({ route: "/organizaciones" });
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
    expect(window.location.pathname).toBe("/organizaciones");
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
    const { store } = renderApp({ route: "/organizaciones/org-1" });
    await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
    const adaClient = store.getSnapshot().client;

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(window.location.pathname).toBe("/panel");
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
    expect(window.location.pathname).toBe("/panel");
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
    renderApp({ route: "/organizaciones/org-1" });
    await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
    expired = true;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(
      await screen.findByText("Tu sesión no está disponible o expiró."),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/panel");
  });

  it("another person answering the profile resets the URL to the panel", async () => {
    let answer = ada;
    mockTransport(appRoutes(() => jsonResponse({ profile: answer })));
    renderApp({ route: "/organizaciones/org-1/grupos" });
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
    expect(window.location.pathname).toBe("/panel");
  });
});
