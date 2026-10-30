import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  NO_PERMISSIONS,
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
  serializeClient,
  type RouteHandler,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SECRET = "Tmp-Sentinel-9f3a-QZ";
const admin = profileFixture({
  id: "00000000-0000-4000-b000-000000000001",
  name: "Ada Admin",
  rut: "123456785",
  isPlatformAdministrator: true,
});

interface Person {
  id: string;
  name: string;
  rut: string;
  disabledAt: string | null;
  recentlyActive: boolean;
  mustChangePassword: boolean;
}

/** A small mutable "database" behind the admin endpoints. */
function makeDb() {
  const people: Person[] = [
    {
      id: "00000000-0000-4000-b000-000000000001",
      name: "Ada Admin",
      rut: "123456785",
      disabledAt: null,
      recentlyActive: true,
      mustChangePassword: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Bruno Díaz",
      rut: "111111111",
      disabledAt: null,
      recentlyActive: true,
      mustChangePassword: false,
    },
    {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Carla Soto",
      rut: "190347907",
      disabledAt: "2026-10-01T00:00:00.000Z",
      recentlyActive: false,
      mustChangePassword: false,
    },
  ];
  return people;
}

function adminRoutes(
  people: Person[],
  overrides: Record<string, RouteHandler> = {},
): Record<string, RouteHandler> {
  const find = (path: string) =>
    people.find(({ id }) => id === path.split("/").at(-1)) as Person;
  const detail = (person: Person) => ({
    user: {
      ...person,
      email:
        person.id === "00000000-0000-4000-8000-000000000002"
          ? "bruno@example.test"
          : null,
      isPlatformAdministrator:
        person.id === "00000000-0000-4000-b000-000000000001",
    },
    memberships:
      person.id === "00000000-0000-4000-8000-000000000002"
        ? [
            {
              organization: {
                id: "00000000-0000-4000-9000-000000000001",
                name: "Academia Norte",
                slug: "norte",
              },
              role: "USER",
              permissions: {
                ...NO_PERMISSIONS,
                readInvoices: true,
                createInvoices: true,
              },
              groups: [
                {
                  group: {
                    id: "00000000-0000-4000-a000-000000000097",
                    name: "Contabilidad",
                  },
                  permissions: { ...NO_PERMISSIONS, readInvoices: true },
                },
              ],
            },
          ]
        : [],
  });
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/admin/users": ({ search }) => {
      const query = new URLSearchParams(search);
      const term = (query.get("search") ?? "").toLowerCase();
      const status = query.get("status") ?? "all";
      const matching = people.filter(
        (person) =>
          person.name.toLowerCase().includes(term) &&
          (status === "all" ||
            (status === "disabled") === (person.disabledAt !== null)),
      );
      return jsonResponse({
        users: matching.map(
          ({ id, name, rut, disabledAt, recentlyActive }) => ({
            id,
            name,
            rut,
            disabledAt,
            recentlyActive,
          }),
        ),
        page: Number(query.get("page")),
        pageSize: Number(query.get("pageSize")),
        total: matching.length,
      });
    },
    ...Object.fromEntries(
      [
        "00000000-0000-4000-b000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000003",
      ].flatMap((id) => [
        [`GET /api/v1/admin/users/${id}`, () => jsonResponse(detail(find(id)))],
      ]),
    ),
    ...overrides,
  };
}

const row = (name: string) =>
  screen.getByRole("link", { name }).closest("tr") as HTMLElement;

describe("admin users directory (AC-13)", () => {
  it("lists users with name, RUT, status and activity as text, and links to each profile", async () => {
    mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin" });
    await screen.findByRole("heading", { level: 1, name: "Administración" });
    const table = await screen.findByRole("table", {
      name: "Usuarios de la plataforma",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["Nombre", "RUT", "Estado", "Actividad"]);
    const bruno = within(row("Bruno Díaz"));
    expect(bruno.getByText("11.111.111-1")).toBeTruthy();
    expect(bruno.getByText("Habilitado")).toBeTruthy();
    expect(bruno.getByText("Activo")).toBeTruthy();
    const carla = within(row("Carla Soto"));
    expect(carla.getByText("Desactivado")).toBeTruthy();
    expect(carla.getByText("Inactivo")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Bruno Díaz" }).getAttribute("href"),
    ).toBe("/admin/users/00000000-0000-4000-8000-000000000002");
    expect(
      screen.getByRole("link", { name: "Crear usuario" }).getAttribute("href"),
    ).toBe("/admin/users/new");
  });

  it("keeps search, status and page in the URL and sends them to the server", async () => {
    const transport = mockTransport(
      adminRoutes(makeDb(), {
        "GET /api/v1/admin/users": ({ search }) => {
          const query = new URLSearchParams(search);
          return jsonResponse({
            users: [
              {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Bruno Díaz",
                rut: "111111111",
                disabledAt: null,
                recentlyActive: true,
              },
            ],
            page: Number(query.get("page")),
            pageSize: 20,
            total: 45,
          });
        },
      }),
    );
    renderApp({ route: "/admin" });
    await screen.findByRole("link", { name: "Bruno Díaz" });
    expect(transport.calls("GET /api/v1/admin/users")[0].search).toBe(
      "?status=all&page=1&pageSize=20",
    );
    expect(screen.getByText("Página 1 de 3")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Anterior" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(window.location.search).toBe("?page=2"));
    await screen.findByText("Página 2 de 3");
    expect(transport.calls("GET /api/v1/admin/users").at(-1)?.search).toBe(
      "?status=all&page=2&pageSize=20",
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Siguiente" })
          .getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("Página 3 de 3");
    expect(
      screen
        .getByRole("button", { name: "Siguiente" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    // A new search starts again at page 1, and the filter joins the URL.
    fireEvent.change(screen.getByLabelText("Buscar por nombre o RUT"), {
      target: { value: " Bru " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(window.location.search).toBe("?search=Bru"));
    fireEvent.change(screen.getByLabelText("Estado de la cuenta"), {
      target: { value: "disabled" },
    });
    await waitFor(() =>
      expect(window.location.search).toBe("?search=Bru&status=disabled"),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/admin/users").at(-1)?.search).toBe(
        "?status=disabled&page=1&pageSize=20&search=Bru",
      ),
    );

    // Back restores the previous state from the URL alone.
    await act(async () => window.history.back());
    await waitFor(() => expect(window.location.search).toBe("?search=Bru"));
    expect(
      (screen.getByLabelText("Estado de la cuenta") as HTMLSelectElement).value,
    ).toBe("all");
    expect(
      (screen.getByLabelText("Buscar por nombre o RUT") as HTMLInputElement)
        .value,
    ).toBe("Bru");
  });

  it("opens straight on a filtered, paged URL", async () => {
    const transport = mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin?search=carla&status=disabled&page=2" });
    await screen.findByRole("heading", { level: 1, name: "Administración" });
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/admin/users")[0]?.search).toBe(
        "?status=disabled&page=2&pageSize=20&search=carla",
      ),
    );
    expect(
      (screen.getByLabelText("Estado de la cuenta") as HTMLSelectElement).value,
    ).toBe("disabled");
  });

  it("says when nothing matches, and offers a retry when the read fails", async () => {
    let fail = true;
    mockTransport(
      adminRoutes(makeDb(), {
        "GET /api/v1/admin/users": () =>
          fail
            ? errorResponse(500, "INTERNAL_ERROR")
            : jsonResponse({ users: [], page: 1, pageSize: 20, total: 0 }),
      }),
    );
    renderApp({ route: "/admin" });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar los usuarios.",
    );
    fail = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar usuarios" }),
    );
    expect(
      await screen.findByText("No hay usuarios que coincidan"),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows loading first", async () => {
    const hold = deferred<Response>();
    mockTransport(
      adminRoutes(makeDb(), { "GET /api/v1/admin/users": () => hold.promise }),
    );
    renderApp({ route: "/admin" });
    expect(await screen.findByText("Cargando usuarios...")).toBeTruthy();
  });

  it("keeps /admin and its sub-routes as not-found for everyone else", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: profileFixture() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Página no encontrada",
    });
  });
});

describe("admin user profile (AC-13)", () => {
  it("shows the data, status and memberships with links to the member screen", async () => {
    const people = makeDb();
    people[1].mustChangePassword = true;
    mockTransport(adminRoutes(people));
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    const data = screen.getByRole("region", { name: "Datos" });
    expect(data.textContent).toContain("RUT11.111.111-1");
    expect(data.textContent).toContain("Correobruno@example.test");
    expect(data.textContent).toContain("EstadoHabilitado");
    expect(data.textContent).toContain("ActividadActivo");
    expect(data.textContent).toContain("Cambio de contraseña pendienteSí");
    const table = screen.getByRole("table", {
      name: "Organizaciones de la persona",
    });
    expect(
      within(table)
        .getByRole("link", { name: "Academia Norte" })
        .getAttribute("href"),
    ).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000002",
    );
    expect(within(table).getByText("Usuario")).toBeTruthy();
    expect(within(table).getByText("2 de 4 permisos")).toBeTruthy();
    expect(within(table).getByText("Contabilidad (1 de 4)")).toBeTruthy();
  });

  it("tells where to change a person's role, permissions or groups (CR-284)", async () => {
    mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    const section = screen.getByRole("region", { name: "Organizaciones" });
    const hint = within(section).getByText(
      "Para cambiar rol, permisos o grupos, abre la organización.",
    );
    expect(hint.className).toContain("field-hint");
    // The hint sits above the table whose links it explains.
    expect(
      hint.compareDocumentPosition(within(section).getByRole("table")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("says nothing about organizations to open when the person has none", async () => {
    mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByText("Esta persona no pertenece a ninguna organización."),
    ).toBeTruthy();
    expect(screen.queryByText(/abre la organización/)).toBeNull();
  });

  it("refreshes the signed-in profile when the person edits their own account, and only then (CR-286)", async () => {
    const people = makeDb();
    const transport = mockTransport(
      adminRoutes(people, {
        "PATCH /api/v1/admin/users/00000000-0000-4000-b000-000000000001": ({
          body,
        }) => {
          Object.assign(people[0], body);
          return jsonResponse({
            user: {
              id: "00000000-0000-4000-b000-000000000001",
              name: people[0].name,
            },
          });
        },
        "PATCH /api/v1/admin/users/00000000-0000-4000-8000-000000000002": ({
          body,
        }) => {
          Object.assign(people[1], body);
          return jsonResponse({
            user: {
              id: "00000000-0000-4000-8000-000000000002",
              name: people[1].name,
            },
          });
        },
      }),
    );
    const profileReads = () =>
      transport.calls("GET /api/v1/auth/profile").length;
    /** Edits the name on the person's screen; returns the profile reads seen
     * once the screen was up, just before saving. */
    const save = async (name: string, route: string, heading: string) => {
      renderApp({ route });
      await screen.findByRole("heading", { level: 1, name: heading });
      const before = profileReads();
      fireEvent.click(screen.getByRole("button", { name: "Editar" }));
      const dialog = screen.getByRole("dialog", { name: "Editar usuario" });
      fireEvent.change(within(dialog).getByLabelText("Nombre"), {
        target: { value: name },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Guardar cambios" }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await screen.findByRole("heading", { level: 1, name });
      return before;
    };

    // Someone else: the signed-in profile is not read again.
    const beforeOther = await save(
      "Bruno Díaz Pérez",
      "/admin/users/00000000-0000-4000-8000-000000000002",
      "Bruno Díaz",
    );
    expect(profileReads()).toBe(beforeOther);
    cleanup();

    // Their own account: the profile (shell name, identity) is read again.
    const beforeSelf = await save(
      "Ada Admin Lovelace",
      "/admin/users/00000000-0000-4000-b000-000000000001",
      "Ada Admin",
    );
    await waitFor(() => expect(profileReads()).toBeGreaterThan(beforeSelf));
  });

  it("answers an unknown person with not-found", async () => {
    mockTransport(
      adminRoutes(makeDb(), {
        "GET /api/v1/admin/users/ghost": () => errorResponse(404, "NOT_FOUND"),
      }),
    );
    renderApp({ route: "/admin/users/ghost" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Página no encontrada",
    });
  });

  it("edits name and RUT in a dialog, sends only what changed and refreshes the profile and the directory", async () => {
    const people = makeDb();
    const transport = mockTransport(
      adminRoutes(people, {
        "PATCH /api/v1/admin/users/00000000-0000-4000-8000-000000000002": ({
          body,
        }) => {
          Object.assign(people[1], body);
          return jsonResponse({
            user: {
              id: "00000000-0000-4000-8000-000000000002",
              name: people[1].name,
            },
          });
        },
      }),
    );
    // Through the directory, so its page is cached when the edit happens.
    renderApp({ route: "/admin" });
    fireEvent.click(await screen.findByRole("link", { name: "Bruno Díaz" }));
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    const directoryReads = () =>
      transport.calls("GET /api/v1/admin/users").length;
    const detailReads = () =>
      transport.calls(
        "GET /api/v1/admin/users/00000000-0000-4000-8000-000000000002",
      ).length;
    const beforeDirectory = directoryReads();
    const beforeDetail = detailReads();
    const edit = screen.getByRole("button", { name: "Editar" });
    fireEvent.click(edit);
    const dialog = screen.getByRole("dialog", { name: "Editar usuario" });
    fireEvent.change(within(dialog).getByLabelText("Nombre"), {
      target: { value: "  Bruno Díaz Pérez " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      transport.calls(
        "PATCH /api/v1/admin/users/00000000-0000-4000-8000-000000000002",
      )[0].body,
    ).toEqual({
      name: "Bruno Díaz Pérez",
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Bruno Díaz Pérez",
      }),
    ).toBeTruthy();
    // Focus returns to the control that opened the dialog.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Editar" }),
    );
    // The profile was read again, and the directory's cached page was marked
    // stale: going back to it reads it again and shows the new name.
    expect(detailReads()).toBeGreaterThan(beforeDetail);
    fireEvent.click(screen.getByRole("link", { name: "Usuarios" }));
    await waitFor(() =>
      expect(directoryReads()).toBeGreaterThan(beforeDirectory),
    );
    expect(
      await screen.findByRole("link", { name: "Bruno Díaz Pérez" }),
    ).toBeTruthy();
  });

  it("reports a duplicate RUT next to the field and keeps the dialog open", async () => {
    mockTransport(
      adminRoutes(makeDb(), {
        "PATCH /api/v1/admin/users/00000000-0000-4000-8000-000000000002": () =>
          errorResponse(409, "USER_CONFLICT"),
      }),
    );
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const dialog = screen.getByRole("dialog", { name: "Editar usuario" });
    const rut = within(dialog).getByLabelText("RUT");
    fireEvent.change(rut, { target: { value: "19.034.790-7" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    const message = await within(dialog).findByText(
      "Ya existe una persona con ese RUT.",
    );
    expect(message.getAttribute("aria-live")).toBe("polite");
    expect(rut.getAttribute("aria-invalid")).toBe("true");
    expect(rut.getAttribute("aria-describedby")).toBe(message.id);
    expect(document.activeElement).toBe(rut);
    // Editing the RUT again clears the stale server message.
    fireEvent.change(rut, { target: { value: "12.345.678-5" } });
    expect(
      within(dialog).queryByText("Ya existe una persona con ese RUT."),
    ).toBeNull();
  });

  it("validates the dialog before sending", async () => {
    const transport = mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const dialog = screen.getByRole("dialog", { name: "Editar usuario" });
    fireEvent.change(within(dialog).getByLabelText("Nombre"), {
      target: { value: "   " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    expect(within(dialog).getByText("Ingresa el nombre.")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Nombre"), {
      target: { value: "Bruno" },
    });
    fireEvent.change(within(dialog).getByLabelText("RUT"), {
      target: { value: "11.111.111-9" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Guardar cambios" }),
    );
    expect(within(dialog).getByText("RUT inválido")).toBeTruthy();
    expect(
      transport.calls(
        "PATCH /api/v1/admin/users/00000000-0000-4000-8000-000000000002",
      ),
    ).toHaveLength(0);
    // Escape closes without sending anything.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("deactivates and reactivates with a confirmation, and explains LAST_ADMIN_REQUIRED", async () => {
    const people = makeDb();
    let refuse = true;
    const transport = mockTransport(
      adminRoutes(people, {
        "POST /api/v1/admin/users/00000000-0000-4000-8000-000000000002/deactivation":
          () => {
            if (refuse) return errorResponse(409, "LAST_ADMIN_REQUIRED");
            people[1].disabledAt = "2026-10-20T00:00:00.000Z";
            return jsonResponse({
              user: {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Bruno Díaz",
                rut: "111111111",
                disabledAt: people[1].disabledAt,
              },
            });
          },
        "DELETE /api/v1/admin/users/00000000-0000-4000-8000-000000000002/deactivation":
          () => {
            people[1].disabledAt = null;
            return jsonResponse({
              user: {
                id: "00000000-0000-4000-8000-000000000002",
                name: "Bruno Díaz",
                rut: "111111111",
                disabledAt: null,
              },
            });
          },
      }),
    );
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });

    fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
    // Nothing is sent before the confirmation.
    expect(
      transport.calls(
        "POST /api/v1/admin/users/00000000-0000-4000-8000-000000000002/deactivation",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar desactivación" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No puedes desactivar a la última persona administradora de la plataforma.",
    );

    refuse = false;
    fireEvent.click(screen.getByRole("button", { name: "Desactivar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar desactivación" }),
    );
    expect(await screen.findByText("Cuenta desactivada.")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Datos" }).textContent,
      ).toContain("EstadoDesactivado"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reactivar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar reactivación" }),
    );
    expect(await screen.findByText("Cuenta reactivada.")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Datos" }).textContent,
      ).toContain("EstadoHabilitado"),
    );
    expect(
      transport.calls(
        "DELETE /api/v1/admin/users/00000000-0000-4000-8000-000000000002/deactivation",
      ),
    ).toHaveLength(1);
  });

  it("hides reset, deactivation and RUT editing on the viewer's own account", async () => {
    mockTransport(adminRoutes(makeDb()));
    renderApp({ route: "/admin/users/00000000-0000-4000-b000-000000000001" });
    await screen.findByRole("heading", { level: 1, name: "Ada Admin" });
    expect(
      screen.queryByRole("button", { name: "Restablecer contraseña" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Desactivar" })).toBeNull();
    expect(screen.getByText(/Esta es tu propia cuenta/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const dialog = screen.getByRole("dialog", { name: "Editar usuario" });
    expect(within(dialog).getByLabelText("Nombre")).toBeTruthy();
    expect(within(dialog).queryByLabelText("RUT")).toBeNull();
  });

  it("explains SELF_ACTION_FORBIDDEN if the server still refuses an action", async () => {
    mockTransport(
      adminRoutes(makeDb(), {
        "POST /api/v1/admin/users/00000000-0000-4000-8000-000000000002/password-reset":
          () => errorResponse(409, "SELF_ACTION_FORBIDDEN"),
      }),
    );
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    fireEvent.click(
      screen.getByRole("button", { name: "Restablecer contraseña" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar restablecimiento" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No puedes realizar esta acción sobre tu propia cuenta.",
    );
  });
});

describe("password reset secret handling (AC-13, AC-14)", () => {
  function resetRoutes(people: Person[], hold?: Promise<Response>) {
    return adminRoutes(people, {
      "POST /api/v1/admin/users/00000000-0000-4000-8000-000000000002/password-reset":
        () => {
          people[1].mustChangePassword = true;
          return (
            hold ??
            jsonResponse({
              temporaryPassword: SECRET,
              expiresAt: "2026-10-30T00:00:00.000Z",
            })
          );
        },
    });
  }
  const resetUser = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Restablecer contraseña" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar restablecimiento" }),
    );
  };
  const acknowledge = () =>
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Ya copié la contraseña",
    });

  it("shows the temporary password once and never lets it into any cache or storage", async () => {
    const people = makeDb();
    const transport = mockTransport(resetRoutes(people));
    const { store } = renderApp({
      route: "/admin/users/00000000-0000-4000-8000-000000000002",
    });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    const client = store.getSnapshot().client;
    resetUser();

    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(SECRET)).toBeTruthy();
    expect(
      transport.calls(
        "POST /api/v1/admin/users/00000000-0000-4000-8000-000000000002/password-reset",
      )[0].body,
    ).toEqual({});
    // Sentinel: the secret is on screen only.
    const everywhere = () =>
      [
        serializeClient(client),
        JSON.stringify({ ...window.localStorage }),
        JSON.stringify({ ...window.sessionStorage }),
      ].join("\n");
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Datos" }).textContent,
      ).toContain("Cambio de contraseña pendienteSí"),
    );
    expect(everywhere()).not.toContain(SECRET);
    // The cache forgets a sensitive mutation when it settles, which happens
    // a tick after the dialog appears.
    await waitFor(() =>
      expect(client.getMutationCache().getAll()).toHaveLength(0),
    );

    fireEvent.click(acknowledge());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    expect(everywhere()).not.toContain(SECRET);
  });

  it("returns focus to the reset button when the dialog closes on the same page", async () => {
    mockTransport(resetRoutes(makeDb()));
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    resetUser();
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    // The dialog's own live control has focus while it is open.
    expect(document.activeElement).toBe(acknowledge());
    fireEvent.click(acknowledge());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Restablecer contraseña" }),
    );
  });

  it("returns focus to the reset button even if the dialog closes before the refetch ends (CR-289)", async () => {
    const people = makeDb();
    const routes = resetRoutes(people);
    const detail =
      routes["GET /api/v1/admin/users/00000000-0000-4000-8000-000000000002"];
    const refetch = deferred<Response>();
    let reads = 0;
    routes["GET /api/v1/admin/users/00000000-0000-4000-8000-000000000002"] = (
      request,
    ) => {
      reads += 1;
      // The first read loads the page; the one after the reset never ends.
      return reads === 1 ? detail(request) : refetch.promise;
    };
    mockTransport(routes);
    renderApp({ route: "/admin/users/00000000-0000-4000-8000-000000000002" });
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    resetUser();
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.click(acknowledge());
    const trigger = screen.getByRole("button", {
      name: "Restablecer contraseña",
    });
    // Enabled although the refetch is still pending, so it can take focus.
    expect(trigger).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(trigger);
    await act(async () => refetch.resolve(await detail({} as never)));
  });

  it("keeps focus on a live control after browser Back, and lands on the page heading when the trigger is gone (CR-116)", async () => {
    const response = deferred<Response>();
    mockTransport(resetRoutes(makeDb(), response.promise));
    renderApp({ route: "/admin" });
    fireEvent.click(await screen.findByRole("link", { name: "Bruno Díaz" }));
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    resetUser();

    // Back to the directory while the reset is still in flight...
    await act(async () => window.history.back());
    await screen.findByRole("heading", { level: 1, name: "Administración" });
    // ...and the credential arrives late, over a page that has no trigger.
    await act(async () =>
      response.resolve(
        jsonResponse({
          temporaryPassword: SECRET,
          expiresAt: "2026-10-30T00:00:00.000Z",
        }),
      ),
    );
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    expect(document.activeElement).toBe(acknowledge());

    fireEvent.click(acknowledge());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Administración" }),
    );
  });

  it("keeps focus inside an open dialog when Back swaps the page behind it", async () => {
    mockTransport(resetRoutes(makeDb()));
    renderApp({ route: "/admin" });
    fireEvent.click(await screen.findByRole("link", { name: "Bruno Díaz" }));
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    resetUser();
    await screen.findByRole("dialog", { name: "Contraseña temporal" });

    await act(async () => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/admin"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      screen.getByRole("dialog", { name: "Contraseña temporal" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(acknowledge());
    fireEvent.click(acknowledge());
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Administración" }),
    );
  });
});

describe("admin partition and identity switch", () => {
  it("leaves nothing of the administrator's directory or user profiles for the next person", async () => {
    let signedIn: "admin" | "other" = "admin";
    const other = profileFixture({
      id: "00000000-0000-4000-8000-000000000009",
      name: "Diego Rojas",
      rut: "111111111",
      memberships: [
        membership(
          { id: "00000000-0000-4000-9000-000000000009", name: "Instituto Sur" },
          "USER",
        ),
      ],
    });
    mockTransport({
      ...adminRoutes(makeDb(), {
        "GET /api/v1/auth/profile": () =>
          jsonResponse({ profile: signedIn === "admin" ? admin : other }),
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000009": () =>
          jsonResponse({
            organization: {
              id: "00000000-0000-4000-9000-000000000009",
              name: "Instituto Sur",
              slug: "sur",
              description: null,
            },
            summary: { memberCount: 1, groupCount: 0 },
          }),
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000009/groups":
          () => jsonResponse({ groups: [] }),
      }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/login": () => {
        signedIn = "other";
        return jsonResponse({ user: {} });
      },
    });
    const { store } = renderApp({ route: "/admin" });
    fireEvent.click(await screen.findByRole("link", { name: "Bruno Díaz" }));
    await screen.findByRole("heading", { level: 1, name: "Bruno Díaz" });
    const clientOfAdmin = store.getSnapshot().client;
    expect(serializeClient(clientOfAdmin)).toContain("bruno@example.test");
    expect(
      clientOfAdmin
        .getQueryCache()
        .getAll()
        .some(
          ({ queryKey }) =>
            queryKey.slice(0, 3).join("/") ===
            "identity/00000000-0000-4000-b000-000000000001/admin",
        ),
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "111111111" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "another-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Diego Rojas/);

    const clientOfOther = store.getSnapshot().client;
    expect(clientOfOther).not.toBe(clientOfAdmin);
    expect(clientOfAdmin.getQueryCache().getAll()).toHaveLength(0);
    const dump = serializeClient(clientOfOther);
    for (const leaked of [
      "bruno@example.test",
      "Carla Soto",
      "Bruno Díaz",
      "00000000-0000-4000-b000-000000000001",
    ])
      expect(dump).not.toContain(leaked);
    expect(
      clientOfOther
        .getQueryCache()
        .getAll()
        .some(({ queryKey }) => queryKey.includes("admin")),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("Bruno Díaz");
    expect(window.location.pathname).toBe("/dashboard");
  });
});
