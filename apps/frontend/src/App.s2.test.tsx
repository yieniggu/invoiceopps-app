import { namedId } from "./test/ids";
import { ACCESS_NONE, NO_PERMISSIONS } from "./test/transport";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { App } from "./App";

const organizations = ["A", "B"].map((id) => ({
  id: namedId("org", id),
  name: `Academia ${id}`,
  slug: id,
}));
const profile = {
  id: "00000000-0000-4000-8000-0000000000b1",
  name: "Ada",
  rut: "12345678-5",
  email: "ada@example.test",
  username: "ada",
  isPlatformAdministrator: false,
  memberships: organizations.map((organization) => ({
    organization,
    role: "USER",
    ...ACCESS_NONE,
  })),
};
const groups = organizations.map((organization, index) => ({
  id: namedId("group", index),
  name: `Equipo ${index}`,
  description: "Investigación aplicada",
  organization,
  members: [
    {
      id: "00000000-0000-4000-8000-0000000000b1",
      name: "Ada",
      rut: "12345678-5",
    },
  ],
}));
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function http(current = profile, membershipGroups = groups) {
  const patch = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValue(json({ profile: current }));
  const mutation = vi.fn<() => Promise<Response>>().mockResolvedValue(json({}));
  const readGroups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: membershipGroups }));
  // Organization-scoped catalogue behind Mis grupos (no permissions, no members).
  const readOrgGroups = vi
    .fn<(organizationId: string) => Promise<Response>>()
    .mockImplementation(async (organizationId) =>
      json({
        groups: membershipGroups
          .filter((group) => group.organization.id === organizationId)
          .map((group) => ({
            id: group.id,
            organizationId,
            name: group.name,
            description: group.description,
          })),
      }),
    );
  const readMembers = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        memberships: [
          {
            userId: "00000000-0000-4000-8000-0000000000b1",
            groupId: "00000000-0000-4000-a000-000000000000",
            organizationId: "00000000-0000-4000-9000-f9e9c6048aeb",
            permissions: NO_PERMISSIONS,
            user: {
              id: "00000000-0000-4000-8000-0000000000b1",
              name: "Ada",
              rut: "123456785",
            },
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      }),
    );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input.toString();
      if (path === "/api/v1/auth/profile" || path === "/api/v1/profile")
        return init?.method === "PATCH" ? patch() : json({ profile: current });
      if (path === "/api/v1/groups") return readGroups();
      if (path.split("?")[0] === "/api/v1/organizations")
        return json({
          page: 1,
          pageSize: 20,
          total: 1,
          organizations: [
            {
              id: "outside",
              name: "Organización externa",
              slug: "externa",
              description: null,
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        });
      const method = init?.method ?? "GET";
      const scoped =
        /^\/api\/v1\/organizations\/([^/]+)\/(groups|users)(?:\?.*)?$/.exec(
          path,
        );
      if (scoped && method === "GET")
        return scoped[2] === "groups"
          ? readOrgGroups(scoped[1])
          : json({
              users: [
                {
                  id: "00000000-0000-4000-8000-000000000900",
                  name: "Nuevo",
                  rut: "190347907",
                  role: "USER",
                },
              ],
              page: 1,
              pageSize: 100,
              total: 1,
            });
      if (
        /^\/api\/v1\/organizations\/[^/]+\/groups\/[^/]+\/memberships(?:\?.*)?$/.test(
          path,
        ) &&
        method === "GET"
      )
        return readMembers();
      // The check of the selection before adding people to a group.
      if (
        /^\/api\/v1\/organizations\/[^/]+\/memberships\?/.test(path) &&
        method === "GET"
      )
        return json({
          memberships: [
            {
              userId: "00000000-0000-4000-8000-000000000900",
              user: { id: "00000000-0000-4000-8000-000000000900" },
            },
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        });
      if (path.startsWith("/api/v1/organizations/")) return mutation();
      if (path.startsWith("/api/v1/invoices?"))
        return json({ invoices: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  return {
    patch,
    mutation,
    readGroups,
    readOrgGroups,
    readMembers,
    fetchMock,
  };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
/** The workspace owner is chosen in the Facturas / Políticas selector. */
async function chooseOwner(value: string) {
  fireEvent.change(await screen.findByLabelText("Propietario"), {
    target: { value },
  });
}
/** The group summary, opened from the group card. */
async function openGroup(name: string) {
  fireEvent.click(
    await screen.findByRole("link", { name: `Ver grupo ${name}` }),
  );
  await screen.findByRole("heading", { level: 1, name });
}
/** Permissions live on the person's page: group, then Miembros, then person. */
async function openGroupMember(group: string, member: string) {
  await openGroup(group);
  fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
  fireEvent.click(await screen.findByRole("link", { name: member }));
  await screen.findByRole("heading", { level: 1, name: member });
}
async function start(name = "Panel principal") {
  render(<App />);
  await screen.findByRole("navigation");
  navigate(name);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S2 identity and authorized workspace presentation", () => {
  it("shows actual identity, memberships and existing dashboard entry points without loading invoice KPIs", async () => {
    const api = http();
    await start();
    expect(
      screen.getByRole("heading", { name: "Tu espacio de trabajo" }),
    ).toBeTruthy();
    expect(screen.getByText(/Bienvenido, Ada/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("link", { name: "Ver mis organizaciones" }),
    );
    expect(
      screen.getByRole("heading", { name: "Organizaciones", level: 1 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Ver detalle de Academia B" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Usar (Academia|Organización)/ }),
    ).toBeNull();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        /^\/api\/v1\/invoices\?/.test(path.toString()),
      ),
    ).toBe(false);
  });

  it("announces profile pending/error, preserves input and sends only existing editable fields", async () => {
    const api = http();
    const save = pending<Response>();
    api.patch.mockReturnValueOnce(save.promise);
    await start("Mi perfil");
    expect(
      screen.getByRole("region", { name: "Membresías del perfil" }),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Nombre" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "RUT" })).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
      { target: { value: "nuevo@example.test" } },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Nombre de usuario" }),
      { target: { value: "nuevo" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Guardando cambios del perfil...",
    );
    expect(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
    ).toHaveProperty("disabled", true);
    await act(async () => save.resolve(json({}, 409)));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No fue posible actualizar el perfil",
    );
    expect(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
    ).toHaveProperty("value", "nuevo@example.test");
    // The one save that was sent (not "the last call": other reads may follow).
    expect(
      api.fetchMock.mock.calls.filter(([path]) => path === "/api/v1/profile"),
    ).toEqual([
      [
        "/api/v1/profile",
        expect.objectContaining({
          body: JSON.stringify({
            email: "nuevo@example.test",
            username: "nuevo",
          }),
        }),
      ],
    ]);
  });

  it("selects only the current user's individual context from the invoice workspace selector and propagates it", async () => {
    const api = http();
    await start("Facturas");
    await chooseOwner(
      "00000000-0000-4000-9000-fa19c6501c7e:user:00000000-0000-4000-8000-0000000000b1",
    );
    navigate("Panel principal");
    expect(
      screen.getByRole("region", { name: "Tu espacio de trabajo" }).textContent,
    ).toContain("Academia BModalidadTrabajo individual");
    navigate("Facturas");
    await waitFor(() =>
      expect(
        api.fetchMock.mock.calls.some(([path]) =>
          path
            .toString()
            .startsWith(
              "/api/v1/invoices?organizationId=00000000-0000-4000-9000-fa19c6501c7e&ownerType=user&ownerId=00000000-0000-4000-8000-0000000000b1",
            ),
        ),
      ).toBe(true),
    );
    // The selector moved the workspace from the default owner to Academia B.
    const invoiceReads = api.fetchMock.mock.calls
      .map(([path]) => path.toString())
      .filter((path) => /^\/api\/v1\/invoices\?/.test(path));
    expect(invoiceReads.at(-1)).toContain(
      "organizationId=00000000-0000-4000-9000-fa19c6501c7e",
    );
  });

  it("selects a loaded membership group in the invoice owner selector and retains that context on the dashboard and invoices", async () => {
    const api = http();
    await start("Facturas");
    // The owner is chosen only in the Facturas selector: there is no
    // per-group "Trabajar con" button any more.
    await chooseOwner(
      "00000000-0000-4000-9000-fa19c6501c7e:group:00000000-0000-4000-a000-000000000001",
    );
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
    navigate("Panel principal");
    expect(
      screen.getByRole("region", { name: "Tu espacio de trabajo" }).textContent,
    ).toContain("Academia BModalidadGrupo: Equipo 1");
    fireEvent.click(screen.getByRole("link", { name: "Ir a facturas" }));
    await screen.findByText("No hay facturas para este propietario.");
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        path
          .toString()
          .startsWith(
            "/api/v1/invoices?organizationId=00000000-0000-4000-9000-fa19c6501c7e&ownerType=group&ownerId=00000000-0000-4000-a000-000000000001",
          ),
      ),
    ).toBe(true);
    // Group deletion no longer exists in the contract.
    expect(screen.queryByRole("button", { name: /Eliminar grupo/ })).toBeNull();
  });

  it("separates platform discovery from memberships and never offers external groups as workspace owners", async () => {
    const api = http({
      ...profile,
      isPlatformAdministrator: true,
      memberships: [],
    });
    await start("Organizaciones");
    // AC-15: the platform administrator lists every organization from the
    // paginated directory, member or not, and keeps the create action.
    expect(
      await screen.findByRole("link", {
        name: "Ver detalle de Organización externa",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Aún no perteneces a ninguna organización/),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Crear organización" }),
    ).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) =>
          path.toString() === "/api/v1/organizations?page=1&pageSize=20",
      ),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: /^Usar (Academia|Organización)/ }),
    ).toBeNull();
    navigate("Grupos");
    // Platform authority lists organizations; it opens no groups of them.
    expect(
      await screen.findByText(/No tienes organizaciones asignadas/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Ver grupo Equipo externo" }),
    ).toBeNull();
    expect(api.readOrgGroups).not.toHaveBeenCalled();
    navigate("Panel principal");
    expect(
      screen.getByText("Elige una organización o grupo para empezar."),
    ).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        /^\/api\/v1\/invoices\?/.test(path.toString()),
      ),
    ).toBe(false);
  });

  it("shows actual group loading/error/retry without presenting an empty list as confirmed", async () => {
    const api = http();
    const read = pending<Response>();
    api.readOrgGroups.mockReturnValueOnce(read.promise);
    await start("Grupos");
    expect(
      (await screen.findByText("Cargando grupos...")).getAttribute("role"),
    ).toBe("status");
    expect(
      screen.queryByText(
        "No perteneces a ningún grupo de esta organización todavía.",
      ),
    ).toBeNull();
    await act(async () => read.resolve(json({}, 500)));
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar grupos" }),
    );
    expect(
      await screen.findByRole("link", { name: "Ver grupo Equipo 0" }),
    ).toBeTruthy();
  });

  it("keeps a failed member permission draft, names the pending action and announces the successful save", async () => {
    const api = http({
      ...profile,
      memberships: [
        { organization: organizations[0], role: "ADMIN", ...ACCESS_NONE },
      ],
    });
    const change = pending<Response>();
    api.mutation.mockReturnValueOnce(change.promise);
    await start("Grupos");
    await openGroupMember("Equipo 0", "Ada");
    const editor = await screen.findByRole("group", {
      name: "Permisos en el grupo «Equipo 0» — Ada",
    });
    const create = within(editor).getByRole("button", {
      name: "Crear facturas",
    });
    const save = screen.getByRole("button", {
      name: "Guardar permisos de Ada",
    });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(create);
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    expect((await screen.findByText("Guardando…")).getAttribute("role")).toBe(
      "status",
    );
    expect(save).toHaveProperty("disabled", true);
    await act(async () => change.resolve(json({}, 403)));
    expect(
      await screen.findByText(
        "No fue posible guardar los permisos. Tus cambios siguen en pantalla; intenta nuevamente.",
      ),
    ).toBeTruthy();
    expect(create.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(save);
    expect(await screen.findByText("Permisos guardados")).toBeTruthy();
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups/00000000-0000-4000-a000-000000000000/memberships/00000000-0000-4000-8000-0000000000b1/permissions",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          permissions: {
            readInvoices: false,
            createInvoices: true,
            deleteOwnInvoices: false,
            deleteOthersInvoices: false,
          },
        }),
      }),
    );
  });

  it.each([
    {
      action: "create",
      button: "Crear grupo",
      method: "POST",
      path: "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups",
      body: { name: "Nuevo equipo" },
      done: "Grupo creado. Agrega a sus miembros.",
    },
    {
      action: "add",
      button: "Agregar 1 persona al grupo",
      method: "POST",
      path: "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups/00000000-0000-4000-a000-000000000000/memberships/bulk",
      body: {
        members: [
          {
            userId: "00000000-0000-4000-8000-000000000900",
            permissions: {
              readInvoices: false,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
          },
        ],
      },
      done: "1 persona agregada al grupo.",
    },
    {
      action: "remove",
      button: "Confirmar quitar a Ada",
      method: "DELETE",
      path: "/api/v1/organizations/00000000-0000-4000-9000-f9e9c6048aeb/groups/00000000-0000-4000-a000-000000000000/memberships/00000000-0000-4000-8000-0000000000b1",
      body: undefined,
      done: "Se quitó a Ada del grupo.",
    },
  ])(
    "preserves the $action group contract and prevents a second pending mutation",
    async ({ action, button, method, path, body, done }) => {
      const api = http({
        ...profile,
        memberships: [
          { organization: organizations[0], role: "ADMIN", ...ACCESS_NONE },
        ],
      });
      const mutation = pending<Response>();
      api.mutation.mockReturnValueOnce(mutation.promise);
      await start("Grupos");
      if (action === "create") {
        fireEvent.click(
          await screen.findByRole("link", {
            name: "Crear grupo en Academia A",
          }),
        );
        fireEvent.change(
          await screen.findByRole("textbox", { name: "Nombre del grupo" }),
          { target: { value: "Nuevo equipo" } },
        );
      } else if (action === "add") {
        await openGroup("Equipo 0");
        fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
        fireEvent.click(
          await screen.findByRole("link", { name: "Agregar miembros" }),
        );
        fireEvent.click(await screen.findByRole("checkbox", { name: /Nuevo/ }));
      } else {
        await openGroupMember("Equipo 0", "Ada");
        fireEvent.click(
          await screen.findByRole("button", { name: "Quitar a Ada del grupo" }),
        );
      }
      const control = await screen.findByRole("button", { name: button });
      fireEvent.click(control);
      // The pending state is derived from the mutation: it paints one tick later.
      const guard =
        action === "remove"
          ? await screen.findByRole("button", {
              name: "Quitar a Ada del grupo",
            })
          : control;
      await waitFor(() => expect(guard).toHaveProperty("disabled", true));
      fireEvent.click(guard);
      expect(api.mutation).toHaveBeenCalledTimes(1);
      const request = api.fetchMock.mock.calls.find(
        ([input, init]) => input.toString() === path && init?.method === method,
      );
      expect(request?.[1]).toEqual(
        expect.objectContaining({ method, credentials: "same-origin" }),
      );
      expect(request?.[1]?.body).toBe(
        body === undefined ? undefined : JSON.stringify(body),
      );
      // The created group is answered with an existing id, so its screen opens.
      await act(async () =>
        mutation.resolve(
          json(
            action === "create"
              ? { group: { id: "00000000-0000-4000-a000-000000000000" } }
              : {},
          ),
        ),
      );
      await screen.findByText(done);
      // The write refreshes what it changed: the organization's groups after
      // creating one, the group's memberships after adding or removing.
      await waitFor(() =>
        expect(
          (action === "create" ? api.readOrgGroups : api.readMembers).mock.calls
            .length,
        ).toBeGreaterThanOrEqual(2),
      );
    },
  );

  it("distinguishes a committed permission save from a failed refresh and retries only the read", async () => {
    const api = http({
      ...profile,
      memberships: [
        { organization: organizations[0], role: "ADMIN", ...ACCESS_NONE },
      ],
    });
    await start("Grupos");
    await openGroupMember("Equipo 0", "Ada");
    const editor = await screen.findByRole("group", {
      name: "Permisos en el grupo «Equipo 0» — Ada",
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Leer facturas" }),
    );
    api.readMembers.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar permisos de Ada" }),
    );
    // The confirmed write stays visible while the refresh fails.
    expect(await screen.findByText("Permisos guardados")).toBeTruthy();
    const stale =
      "No fue posible actualizar los datos del miembro. Tus cambios ya se guardaron; no repitas la operación.";
    expect(await screen.findByText(stale)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar miembro" }));
    await waitFor(() => expect(screen.queryByText(stale)).toBeNull());
    expect(api.mutation).toHaveBeenCalledTimes(1);
    // Summary count, members table, member page mount, the refresh after the
    // write (500) and the single retried read.
    expect(api.readMembers).toHaveBeenCalledTimes(5);
  });

  it("keeps a membership-free identity honest and does not manufacture group or invoice data", async () => {
    const api = http({ ...profile, memberships: [] });
    await start();
    expect(
      screen.getByText("Elige una organización o grupo para empezar."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("link", { name: "Ver mis organizaciones" }),
    );
    expect(
      screen.getByText(/Aún no perteneces a ninguna organización/),
    ).toBeTruthy();
    navigate("Grupos");
    expect(screen.getByText(/No tienes organizaciones asignadas/)).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Crear grupo|Trabajar con|Eliminar grupo/,
      }),
    ).toBeNull();
    expect(api.fetchMock).toHaveBeenCalledTimes(1);
    expect(api.readGroups).not.toHaveBeenCalled();
  });

  it("preserves native validation for contact and group fields before any mutation", async () => {
    const api = http({
      ...profile,
      memberships: [
        { organization: organizations[0], role: "ADMIN", ...ACCESS_NONE },
      ],
    });
    await start("Mi perfil");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
      { target: { value: "invalid-email" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(
      screen
        .getByRole<HTMLInputElement>("textbox", { name: "Correo electrónico" })
        .checkValidity(),
    ).toBe(false);
    expect(api.patch).not.toHaveBeenCalled();
    navigate("Grupos");
    fireEvent.click(
      await screen.findByRole("link", { name: "Crear grupo en Academia A" }),
    );
    const name = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Nombre del grupo",
    });
    for (const value of ["", "   "]) {
      fireEvent.change(name, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
      // Own validation: Spanish text, aria-invalid and focus, no request.
      expect(name.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByText("Ingresa el nombre del grupo.")).toBeTruthy();
      expect(document.activeElement).toBe(name);
    }
    expect(api.mutation).not.toHaveBeenCalled();
  });

  it("distinguishes suspended context validation from no membership and recovers from Organizations", async () => {
    const api = http();
    const read = pending<Response>();
    api.readGroups.mockReturnValueOnce(read.promise);
    await start();
    expect(screen.getByRole("status").textContent).toBe(
      "Validando tu espacio de trabajo...",
    );
    expect(
      screen.queryByText("Elige una organización o grupo para empezar."),
    ).toBeNull();
    await act(async () => read.resolve(json({}, 500)));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible validar tu espacio de trabajo.",
    );
    expect(
      screen.getByRole("button", { name: "Reintentar espacio de trabajo" }),
    ).toBeTruthy();
    navigate("Organizaciones");
    expect(screen.getByRole("alert").textContent).toBe(
      "No fue posible cargar el contexto de las organizaciones.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reintentar contexto organizacional",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    navigate("Facturas");
    await chooseOwner(
      "00000000-0000-4000-9000-fa19c6501c7e:user:00000000-0000-4000-8000-0000000000b1",
    );
    navigate("Panel principal");
    expect(
      screen.getByRole("region", { name: "Tu espacio de trabajo" }).textContent,
    ).toContain("Academia BModalidadTrabajo individual");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retains platform administrator memberships alongside discovery without merging owner permissions", async () => {
    const api = http({ ...profile, isPlatformAdministrator: true });
    await start("Organizaciones");
    expect(
      screen.getByRole("heading", { name: "Organizaciones", level: 1 }),
    ).toBeTruthy();
    // The directory lists the platform-wide organizations (AC-15), which is
    // independent of the memberships kept below for the workspace.
    expect(await screen.findByText("Organización externa")).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) =>
          path.toString() === "/api/v1/organizations?page=1&pageSize=20",
      ),
    ).toBe(true);
    navigate("Facturas");
    await chooseOwner(
      "00000000-0000-4000-9000-fa19c6501c7e:user:00000000-0000-4000-8000-0000000000b1",
    );
    navigate("Grupos");
    expect(
      await screen.findByRole("link", { name: "Ver grupo Equipo 1" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Ver grupo Equipo externo" }),
    ).toBeNull();
    navigate("Facturas");
    await screen.findByText("No hay facturas para este propietario.");
    expect(screen.queryByRole("option", { name: /Equipo externo/ })).toBeNull();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        path.toString().includes("ownerId=outside-group"),
      ),
    ).toBe(false);
  });

  // Computed CSS contracts are not browser geometry, native keyboard or visual QA.
  it("keeps full long identity and group names in bounded wrapping containers", async () => {
    const longName = "Investigación" + "x".repeat(140);
    const organization = { ...organizations[0], name: longName };
    http(
      {
        ...profile,
        name: longName,
        memberships: [{ organization, role: "ADMIN", ...ACCESS_NONE }],
      },
      [{ ...groups[0], name: longName, organization }],
    );
    await start("Mi perfil");
    render(<style>{readFileSync("src/styles.css", "utf8")}</style>);
    const identity = within(
      screen.getByRole("region", { name: "Identidad" }),
    ).getByText(longName);
    expect(identity.textContent).toBe(longName);
    expect(getComputedStyle(identity).overflowWrap).toBe("anywhere");
    navigate("Grupos");
    const heading = await screen.findByRole("heading", {
      name: longName,
      level: 3,
    });
    expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
    const card = heading.parentElement;
    if (!card) throw new Error("Missing group card");
    expect(getComputedStyle(card).minWidth).toBe("0px");
    expect(
      screen.getByRole("link", { name: `Ver grupo ${longName}` }),
    ).toBeTruthy();
  });
});
