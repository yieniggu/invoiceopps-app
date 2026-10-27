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
  id: `org-${id}`,
  name: `Academia ${id}`,
  slug: id,
}));
const profile = {
  id: "person",
  name: "Ada",
  rut: "12345678-5",
  email: "ada@example.test",
  username: "ada",
  isPlatformAdministrator: false,
  memberships: organizations.map((organization) => ({
    organization,
    role: "USER",
  })),
};
const groups = organizations.map((organization, index) => ({
  id: `group-${index}`,
  name: `Equipo ${index}`,
  description: "Investigación aplicada",
  organization,
  members: [{ id: "person", name: "Ada", rut: "12345678-5" }],
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
  // Organization-scoped catalogue behind Mis grupos (permissions, no members).
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
            permissions: {
              readInvoices: false,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
          })),
      }),
    );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input.toString();
      if (path === "/api/v1/auth/profile" || path === "/api/v1/profile")
        return init?.method === "PATCH" ? patch() : json({ profile: current });
      if (path === "/api/v1/groups") return readGroups();
      if (path === "/api/v1/organizations")
        return json({
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
      const scoped = /^\/api\/v1\/organizations\/([^/]+)\/(groups|users)$/.exec(
        path,
      );
      if (scoped && method === "GET")
        return scoped[2] === "groups"
          ? readOrgGroups(scoped[1])
          : json({
              users: [
                {
                  id: "new-member",
                  name: "Nuevo",
                  rut: "190347907",
                  role: "USER",
                },
              ],
            });
      if (
        /^\/api\/v1\/organizations\/[^/]+\/groups\/[^/]+\/memberships$/.test(
          path,
        ) &&
        method === "GET"
      )
        return json({
          memberships: [
            {
              userId: "person",
              groupId: "group-0",
              organizationId: "org-A",
              user: { id: "person", name: "Ada", rut: "123456785" },
            },
          ],
        });
      if (path.startsWith("/api/v1/organizations/")) return mutation();
      if (path.startsWith("/api/v1/invoices?"))
        return json({ invoices: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  return { patch, mutation, readGroups, readOrgGroups, fetchMock };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
/** Permissions and members are managed on the group detail, not the list. */
async function openGroup(name: string) {
  fireEvent.click(
    await screen.findByRole("link", { name: `Ver detalle de ${name}` }),
  );
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
      screen.getByRole("button", { name: "Usar Academia B" }),
    ).toBeTruthy();
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
    expect(api.fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/profile",
      expect.objectContaining({
        body: JSON.stringify({
          email: "nuevo@example.test",
          username: "nuevo",
        }),
      }),
    );
  });

  it("selects only the current user's individual context from an actual organization and propagates it to the invoice workspace", async () => {
    const api = http();
    await start("Organizaciones");
    const use = await screen.findByRole("button", { name: "Usar Academia B" });
    fireEvent.click(use);
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
              "/api/v1/invoices?organizationId=org-B&ownerType=user&ownerId=person",
            ),
        ),
      ).toBe(true),
    );
    expect(
      api.fetchMock.mock.calls
        .filter(([path]) => /^\/api\/v1\/invoices\?/.test(path.toString()))
        .every(([path]) => path.toString().includes("organizationId=org-B")),
    ).toBe(true);
  });

  it("selects a loaded membership group and retains that context on the dashboard and invoices", async () => {
    const api = http();
    await start("Grupos");
    // Groups are listed per organization: Equipo 1 sits in Academia B's section.
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo 1" }),
    );
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
            "/api/v1/invoices?organizationId=org-B&ownerType=group&ownerId=group-1",
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
    expect(
      screen.getByText(/Aún no perteneces a ninguna organización/),
    ).toBeTruthy();
    // Platform authority only adds the create action; it lists nothing.
    expect(
      screen.getByRole("link", { name: "Crear organización" }),
    ).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) => path.toString() === "/api/v1/organizations",
      ),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Usar Organización externa" }),
    ).toBeNull();
    navigate("Grupos");
    // Platform authority lists organizations; it opens no groups of them.
    expect(
      await screen.findByText(/No tienes organizaciones asignadas/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo externo" }),
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
      await screen.findByRole("button", { name: "Trabajar con Equipo 0" }),
    ).toBeTruthy();
  });

  it("keeps a failed permission draft, names the pending action and announces the successful save", async () => {
    const api = http({
      ...profile,
      memberships: [{ organization: organizations[0], role: "ADMIN" }],
    });
    const change = pending<Response>();
    api.mutation.mockReturnValueOnce(change.promise);
    await start("Grupos");
    await openGroup("Equipo 0");
    const editor = await screen.findByRole("group", {
      name: "Permisos sobre facturas",
    });
    const create = within(editor).getByRole("checkbox", {
      name: "Crear facturas",
    });
    fireEvent.click(create);
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    expect(
      await screen.findByRole("button", { name: "Guardando permisos..." }),
    ).toHaveProperty("disabled", true);
    await act(async () => change.resolve(json({}, 403)));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible guardar los permisos. Intenta nuevamente.",
    );
    expect(create).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    expect(await screen.findByText("Permisos guardados.")).toBeTruthy();
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/api/v1/organizations/org-A/groups/group-0",
      expect.objectContaining({
        method: "PATCH",
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
      path: "/api/v1/organizations/org-A/groups",
      body: { name: "Nuevo equipo" },
      done: "Grupo «Nuevo equipo» creado.",
    },
    {
      action: "add",
      button: "Agregar al grupo",
      method: "POST",
      path: "/api/v1/organizations/org-A/groups/group-0/memberships",
      body: { userId: "new-member" },
      done: "Persona agregada al grupo.",
    },
    {
      action: "remove",
      button: "Quitar a Ada del grupo",
      method: "DELETE",
      path: "/api/v1/organizations/org-A/groups/group-0/memberships/person",
      body: undefined,
      done: "Persona quitada del grupo.",
    },
  ])(
    "preserves the $action group contract and prevents a second pending mutation",
    async ({ action, button, method, path, body, done }) => {
      const api = http({
        ...profile,
        memberships: [{ organization: organizations[0], role: "ADMIN" }],
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
      } else {
        await openGroup("Equipo 0");
        await screen.findByRole("group", { name: "Permisos sobre facturas" });
      }
      const control = await screen.findByRole("button", { name: button });
      if (action === "add")
        await screen.findByRole("option", { name: "Nuevo" });
      fireEvent.click(control);
      // The pending state is derived from the mutation: it paints one tick later.
      await waitFor(() => expect(control).toHaveProperty("disabled", true));
      fireEvent.click(control);
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
      // The created group is answered with an existing id, so its detail opens.
      await act(async () =>
        mutation.resolve(
          json(action === "create" ? { group: { id: "group-0" } } : {}),
        ),
      );
      await screen.findByText(done);
      // The write invalidates this organization's groups, which refetch once more.
      await waitFor(() =>
        expect(api.readOrgGroups.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
    },
  );

  it("distinguishes a committed mutation from a failed refresh and retries only the read", async () => {
    const api = http({
      ...profile,
      memberships: [{ organization: organizations[0], role: "ADMIN" }],
    });
    await start("Grupos");
    await openGroup("Equipo 0");
    await screen.findByRole("group", { name: "Permisos sobre facturas" });
    api.readOrgGroups.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    // The confirmed write stays visible while the refresh fails.
    expect(await screen.findByText("Permisos guardados.")).toBeTruthy();
    expect(
      await screen.findByText(
        "No fue posible actualizar la lista de grupos. Tus cambios ya se guardaron; no repitas la operación.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grupos" }));
    await waitFor(() =>
      expect(
        screen.queryByText(
          "No fue posible actualizar la lista de grupos. Tus cambios ya se guardaron; no repitas la operación.",
        ),
      ).toBeNull(),
    );
    expect(api.mutation).toHaveBeenCalledTimes(1);
    // List, detail mount, refresh after the write, and the single retried read.
    expect(api.readOrgGroups).toHaveBeenCalledTimes(4);
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
      memberships: [{ organization: organizations[0], role: "ADMIN" }],
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
    expect(
      screen.getByRole("button", { name: "Usar Academia B" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toBe(
      "No fue posible cargar el contexto de las organizaciones.",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Reintentar contexto organizacional",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Usar Academia B" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Usar Academia B" }));
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
    // Only memberships are listed; the platform-wide list is never read.
    expect(screen.queryByText("Organización externa")).toBeNull();
    expect(
      api.fetchMock.mock.calls.some(
        ([path]) => path.toString() === "/api/v1/organizations",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Usar Academia B" }));
    navigate("Grupos");
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo 1" }),
    );
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo externo" }),
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
        memberships: [{ organization, role: "ADMIN" }],
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
      screen.getByRole("link", { name: `Ver detalle de ${longName}` }),
    ).toBeTruthy();
  });
});
