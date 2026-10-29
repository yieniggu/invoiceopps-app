import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import {
  ACCESS_NONE,
  deferred,
  groupMembershipsPage,
  jsonResponse,
  mockTransport,
  NO_PERMISSIONS,
  organizationsPage,
  profileFixture,
  usersPage,
} from "./test/transport";

// Profile and group tests exercise destinations through the real shell.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function navigate(name: string) {
  const nav = await screen.findByRole("navigation", {
    name: "Navegación principal",
  });
  fireEvent.click(within(nav).getByRole("link", { name }));
}

describe("APP-03 profile", () => {
  it("resolves the authenticated profile, submits permitted fields, and announces success", async () => {
    const patchGate = deferred<Response>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              rut: "12345678-5",
              email: "ada@example.test",
              username: "ada",
              memberships: [
                {
                  organization: {
                    id: "00000000-0000-4000-9000-000000000001",
                    name: "AI Academy",
                    slug: "ai-academy",
                  },
                  role: "USER",
                  ...ACCESS_NONE,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ groups: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(patchGate.promise);

    render(<App />);

    expect(screen.getByRole("status").textContent).toBe(
      "Preparando tu espacio de trabajo",
    );
    await navigate("Mi perfil");
    expect(
      await screen.findByRole("heading", { name: "Mi perfil" }),
    ).toBeTruthy();
    expect(await screen.findByText("12.345.678-5")).toBeTruthy();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Correo electrónico",
        }) as HTMLInputElement
      ).value,
    ).toBe("ada@example.test");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Nombre de usuario",
        }) as HTMLInputElement
      ).value,
    ).toBe("ada");
    await navigate("Organizaciones");
    expect(screen.getByText("AI Academy")).toBeTruthy();
    expect(screen.getByText("Usuario")).toBeTruthy();
    await navigate("Mi perfil");

    fireEvent.change(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
      {
        target: { value: "ada.updated@example.test" },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Nombre de usuario" }),
      {
        target: { value: "ada-updated" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    // The pending state is derived from the mutation, so it paints a tick
    // after the click rather than synchronously.
    const savingButton = await screen.findByRole("button", {
      name: "Guardando cambios...",
    });
    expect(savingButton.hasAttribute("disabled")).toBe(true);
    patchGate.resolve(
      jsonResponse({
        profile: {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Ada Lovelace",
          rut: "12345678-5",
          email: "ada.updated@example.test",
          username: "ada-updated",
          memberships: [],
        },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Perfil actualizado",
      );
    });
    // Not "the last call": once the save settles the app may read the profile
    // again, and when that read starts relative to this line depends on load.
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/v1/profile"),
    ).toEqual([
      [
        "/api/v1/profile",
        expect.objectContaining({
          method: "PATCH",
          credentials: "same-origin",
          body: JSON.stringify({
            email: "ada.updated@example.test",
            username: "ada-updated",
          }),
        }),
      ],
    ]);
  });

  it("renders anonymous session expiry and a recoverable update error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              rut: "12345678-5",
              email: null,
              username: null,
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    const { unmount } = render(<App />);

    expect(
      await screen.findByText("Tu sesión no está disponible o expiró."),
    ).toBeTruthy();
    unmount();

    render(<App />);
    await navigate("Mi perfil");
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible actualizar el perfil. Intenta nuevamente.",
    );
  });

  it("renders a recoverable profile loading error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              rut: "12345678-5",
              email: null,
              username: null,
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar el perfil.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await navigate("Organizaciones");
    expect(
      await screen.findByText(
        "Aún no perteneces a ninguna organización. Pide a un administrador que te agregue.",
      ),
    ).toBeTruthy();
  });

  it("logs out accessibly, prevents duplicate submission, and clears the profile", async () => {
    let completeLogout: (() => void) | undefined;
    const logoutResponse = new Promise<Response>((resolve) => {
      completeLogout = () => resolve(new Response(null, { status: 204 }));
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              rut: "12345678-5",
              email: "ada@example.test",
              username: "ada",
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockReturnValueOnce(logoutResponse);

    render(<App />);

    const logoutButton = await screen.findByRole("button", {
      name: "Salir",
    });
    fireEvent.click(logoutButton);

    expect(
      await screen.findByRole("button", { name: "Saliendo..." }),
    ).toHaveProperty("disabled", true);
    // The request starts once the identity's in-flight reads are cancelled.
    await waitFor(() => expect(completeLogout).toBeDefined());

    completeLogout?.();

    // A voluntary logout is not an expired session: the login says so.
    expect(
      await screen.findByText("Ingresa con tu RUT y contraseña."),
    ).toBeTruthy();
    expect(
      screen.queryByText("Tu sesión no está disponible o expiró."),
    ).toBeNull();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    // Exactly one logout was sent. It is not "the last call": the login screen
    // that appears next starts its own profile read, and whether that read has
    // begun when this line runs depends on how loaded the machine is.
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/v1/auth/logout"),
    ).toEqual([
      ["/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }],
    ]);
  });

  it("keeps the profile and announces a recoverable logout failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              rut: "12345678-5",
              email: "ada@example.test",
              username: "ada",
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Salir" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cerrar la sesión. Intenta nuevamente.",
    );
    await navigate("Mi perfil");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salir" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("APP-04 organization groups", () => {
  const academy = {
    id: "00000000-0000-4000-9000-000000000001",
    name: "AI Academy",
    slug: "ai-academy",
  };
  const orgGroup = (name: string) => ({
    id: "00000000-0000-4000-a000-000000000001",
    organizationId: "00000000-0000-4000-9000-000000000001",
    name,
    description: null,
  });

  it("keeps platform authority out of groups and invoices for an administrator without memberships", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            id: "platform-admin-1",
            isPlatformAdministrator: true,
          }),
        }),
      // AC-15: the organization directory is the one platform-wide read.
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
    });

    render(<App />);
    await navigate("Organizaciones");
    expect(await screen.findByText("Aún no hay organizaciones")).toBeTruthy();
    // Platform authority creates organizations; it is not membership.
    expect(
      screen.getByRole("link", { name: "Crear organización" }),
    ).toBeTruthy();

    await navigate("Grupos");
    expect(
      await screen.findByText(/No tienes organizaciones asignadas/),
    ).toBeTruthy();
    await navigate("Facturas");
    expect(
      await screen.findByText(
        "No tienes organizaciones para consultar facturas.",
      ),
    ).toBeTruthy();
    expect(
      transport.requests.some(
        ({ path }) =>
          path.startsWith("/api/v1/invoices") ||
          path.startsWith("/api/v1/organizations/") ||
          path.includes("/groups"),
      ),
    ).toBe(false);
  });

  it("retries only the organization summary read when it fails, leaving the groups of the administrator alone", async () => {
    let summaryRequests = 0;
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            id: "platform-admin-1",
            isPlatformAdministrator: true,
            memberships: [
              { organization: academy, role: "ADMIN", ...ACCESS_NONE },
            ],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () =>
        jsonResponse(
          organizationsPage([
            { ...academy, description: null, enabled: true, createdAt: "x" },
          ]),
        ),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () => {
        summaryRequests += 1;
        return summaryRequests === 1
          ? new Response(null, { status: 500 })
          : jsonResponse({
              organization: {
                ...academy,
                description: "Sede central",
              },
              summary: { memberCount: 3, groupCount: 1 },
            });
      },
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
        () => jsonResponse({ groups: [orgGroup("Local group")] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () => jsonResponse({ memberships: [] }),
    });

    render(<App />);
    await navigate("Grupos");
    expect(await screen.findByText("Local group")).toBeTruthy();
    await navigate("Organizaciones");
    fireEvent.click(
      await screen.findByRole("link", { name: "Ver detalle de AI Academy" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar organización" }),
    );
    expect(await screen.findByText("Sede central")).toBeTruthy();
    expect(summaryRequests).toBe(2);
    await navigate("Grupos");
    expect(await screen.findByText("Local group")).toBeTruthy();
    expect(screen.queryByText("No fue posible cargar los grupos.")).toBeNull();
    expect(transport.unexpected).toEqual([]);
  });

  it("shows group members to an organization admin together with the administrative controls", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [
              { organization: academy, role: "ADMIN", ...ACCESS_NONE },
            ],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
        () => jsonResponse({ groups: [orgGroup("Advanced topics")] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000001/memberships":
        () =>
          jsonResponse(
            groupMembershipsPage([
              {
                userId: "00000000-0000-4000-8000-0000000000a1",
                groupId: "00000000-0000-4000-a000-000000000001",
                organizationId: "00000000-0000-4000-9000-000000000001",
                permissions: NO_PERMISSIONS,
                user: {
                  id: "00000000-0000-4000-8000-0000000000a1",
                  name: "Grace Hopper",
                  rut: "123456793",
                },
              },
            ]),
          ),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => jsonResponse(usersPage([])),
    });

    render(<App />);
    await navigate("Grupos");
    expect(
      await screen.findByRole("heading", { name: "Grupos", level: 1 }),
    ).toBeTruthy();
    expect(await screen.findByText("Advanced topics")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Crear grupo/ })).toBeTruthy();
    // Members are managed on their own screens: summary, then Miembros.
    fireEvent.click(
      screen.getByRole("link", { name: "Ver grupo Advanced topics" }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
    fireEvent.click(await screen.findByRole("link", { name: "Grace Hopper" }));
    expect(
      await screen.findByRole("button", {
        name: "Quitar a Grace Hopper del grupo",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/12\.345\.679-3/)).toBeTruthy();
  });

  it("hides administrative controls from a student while keeping the empty state accessible", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            id: "00000000-0000-4000-8000-0000000000a1",
            name: "Grace Hopper",
            memberships: [
              { organization: academy, role: "USER", ...ACCESS_NONE },
            ],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
        () => jsonResponse({ groups: [] }),
    });

    render(<App />);
    await navigate("Grupos");
    expect(
      await screen.findByText(
        "No perteneces a ningún grupo de esta organización todavía.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Crear grupo/ })).toBeNull();
  });
});
