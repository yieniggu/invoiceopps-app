import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP-03 profile", () => {
  it("resolves the authenticated profile, submits permitted fields, and announces success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "user-1",
              name: "Ada Lovelace",
              rut: "123456785",
              email: "ada@example.test",
              username: "ada",
              memberships: [
                {
                  organization: {
                    id: "organization-1",
                    name: "AI Academy",
                    slug: "ai-academy",
                  },
                  role: "STUDENT",
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "user-1",
              name: "Ada Lovelace",
              rut: "123456785",
              email: "ada.updated@example.test",
              username: "ada-updated",
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<App />);

    expect(screen.getByRole("status").textContent).toContain("Cargando perfil");
    expect(
      await screen.findByRole("heading", { name: "Mi perfil" }),
    ).toBeTruthy();
    expect(screen.getByText("123456785")).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement)
        .value,
    ).toBe("ada@example.test");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Username",
        }) as HTMLInputElement
      ).value,
    ).toBe("ada");
    expect(screen.getByText("AI Academy")).toBeTruthy();
    expect(screen.getByText("(STUDENT)")).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "ada.updated@example.test" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Username" }), {
      target: { value: "ada-updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    const savingButton = screen.getByRole("button", {
      name: "Guardando cambios...",
    });
    expect(savingButton.hasAttribute("disabled")).toBe(true);

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Perfil actualizado",
      );
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/profile",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({
          email: "ada.updated@example.test",
          username: "ada-updated",
        }),
      }),
    );
  });

  it("renders anonymous session expiry and a recoverable update error", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "user-1",
              name: "Ada Lovelace",
              rut: "123456785",
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
    await screen.findByRole("heading", { name: "Mi perfil" });
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
              id: "user-1",
              name: "Ada Lovelace",
              rut: "123456785",
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
    expect(
      await screen.findByText("No tienes organizaciones asignadas."),
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
              id: "user-1",
              name: "Ada Lovelace",
              rut: "123456785",
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
      name: "Cerrar sesión",
    });
    fireEvent.click(logoutButton);

    expect(
      screen.getByRole("button", { name: "Cerrando sesión..." }),
    ).toHaveProperty("disabled", true);

    completeLogout?.();

    expect(
      await screen.findByText("Tu sesión no está disponible o expiró."),
    ).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  });

  it("keeps the profile and announces a recoverable logout failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              name: "Ada Lovelace",
              rut: "123456785",
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

    fireEvent.click(
      await screen.findByRole("button", { name: "Cerrar sesión" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cerrar la sesión. Intenta nuevamente.",
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cerrar sesión" }),
    ).toHaveProperty("disabled", false);
  });
});

describe("APP-04 organization groups", () => {
  it("keeps globally discovered groups out of resource and invoice contexts for an administrator without local memberships", async () => {
    let resolveDiscovery: ((response: Response) => void) | undefined;
    const discovery = new Promise<Response>((resolve) => {
      resolveDiscovery = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "platform-admin-1",
              name: "Ada Lovelace",
              rut: "123456785",
              email: null,
              username: null,
              isPlatformAdministrator: true,
              memberships: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockReturnValueOnce(discovery);

    render(<App />);

    expect(
      await screen.findByText("Cargando organizaciones administrables..."),
    ).toBeTruthy();
    if (!resolveDiscovery) {
      throw new Error("Platform discovery did not start");
    }
    resolveDiscovery(
      new Response(
        JSON.stringify({
          organizations: [
            {
              id: "organization-1",
              name: "AI Academy",
              groups: [
                {
                  id: "group-1",
                  name: "Advanced topics",
                  description: null,
                  organization: {
                    id: "organization-1",
                    name: "AI Academy",
                  },
                  members: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(await screen.findByText("Advanced topics")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Nuevo grupo" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Crear grupo en AI Academy" }),
    ).toBeTruthy();
    expect(
      screen.getByText("No tienes organizaciones para consultar recursos."),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === "string" &&
          (path.startsWith("/resources") || path.startsWith("/invoices")),
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Ver facturas" }));

    expect(
      await screen.findByText(
        "No tienes organizaciones para consultar facturas.",
      ),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([path]) =>
          typeof path === "string" &&
          (path.startsWith("/resources") || path.startsWith("/invoices")),
      ),
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/platform/organizations", {
      credentials: "same-origin",
    });
  });

  it("reloads local groups when platform organization discovery fails for an administrator with memberships", async () => {
    let groupRequestCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "/profile") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              profile: {
                id: "platform-admin-1",
                name: "Ada Lovelace",
                rut: "123456785",
                email: null,
                username: null,
                isPlatformAdministrator: true,
                memberships: [
                  {
                    organization: {
                      id: "organization-1",
                      name: "AI Academy",
                      slug: "ai-academy",
                    },
                    role: "ADMIN",
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (url === "/platform/organizations") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }

      if (url === "/groups") {
        groupRequestCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              groups: [
                {
                  id: `group-${groupRequestCount}`,
                  name:
                    groupRequestCount === 1
                      ? "Local group"
                      : "Reloaded local group",
                  description: null,
                  organization: { id: "organization-1", name: "AI Academy" },
                  members: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }

      if (url.startsWith("/resources?")) {
        return Promise.resolve(
          new Response(JSON.stringify({ resources: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
    });

    render(<App />);

    expect(await screen.findByText("Local group")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar organizaciones" }),
    );

    expect(await screen.findByText("Reloaded local group")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/groups", {
      credentials: "same-origin",
    });
    expect(screen.queryByText("No fue posible cargar los grupos.")).toBeNull();
    expect(screen.queryByText("No fue posible cargar los recursos.")).toBeNull();
  });

  it("shows group members to an organization member and administrative controls only to admins", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              name: "Ada Lovelace",
              rut: "123456785",
              email: null,
              username: null,
              memberships: [
                {
                  organization: {
                    id: "organization-1",
                    name: "AI Academy",
                    slug: "ai-academy",
                  },
                  role: "ADMIN",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            groups: [
              {
                id: "group-1",
                name: "Advanced topics",
                description: null,
                organization: { id: "organization-1", name: "AI Academy" },
                members: [
                  {
                    id: "student-1",
                    name: "Grace Hopper",
                    rut: "123456793",
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Mis grupos" }),
    ).toBeTruthy();
    expect(screen.getByText("Advanced topics")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Quitar a Grace Hopper" }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Nuevo grupo" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Crear grupo en AI Academy" }),
    ).toBeTruthy();
  });

  it("hides administrative controls from a student while keeping the empty state accessible", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            profile: {
              id: "student-1",
              name: "Grace Hopper",
              rut: "123456793",
              email: null,
              username: null,
              memberships: [
                {
                  organization: {
                    id: "organization-1",
                    name: "AI Academy",
                    slug: "ai-academy",
                  },
                  role: "STUDENT",
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
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ resources: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(<App />);

    expect(
      await screen.findByText("No perteneces a grupos todavía."),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Nuevo grupo" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Crear grupo en/ })).toBeNull();
  });
});
