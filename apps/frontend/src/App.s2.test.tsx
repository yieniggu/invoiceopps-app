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
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input.toString();
      if (path === "/profile")
        return init?.method === "PATCH" ? patch() : json({ profile: current });
      if (path === "/groups") return readGroups();
      if (path === "/platform/organizations")
        return json({
          organizations: [
            {
              id: "outside",
              name: "Organización externa",
              groups: [
                {
                  ...groups[0],
                  id: "outside-group",
                  name: "Equipo externo",
                  organization: { id: "outside", name: "Organización externa" },
                },
              ],
            },
          ],
        });
      if (path.startsWith("/organizations/")) return mutation();
      if (path.startsWith("/invoices?"))
        return json({ invoices: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  return { patch, mutation, readGroups, fetchMock };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("button", { name }),
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
      screen.getByRole("button", { name: "Ver mis organizaciones" }),
    );
    expect(
      screen.getByRole("heading", { name: "Mis membresías" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Usar Academia B" }),
    ).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        /^\/invoices\?/.test(path.toString()),
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
    expect(screen.getByRole("status").textContent).toBe(
      "Guardando cambios del perfil...",
    );
    expect(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
    ).toHaveProperty("disabled", true);
    await act(async () => save.resolve(json({}, 409)));
    expect(screen.getByRole("alert").textContent).toContain(
      "No fue posible actualizar el perfil",
    );
    expect(
      screen.getByRole("textbox", { name: "Correo electrónico" }),
    ).toHaveProperty("value", "nuevo@example.test");
    expect(api.fetchMock).toHaveBeenLastCalledWith(
      "/profile",
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
              "/invoices?organizationId=org-B&ownerType=user&ownerId=person",
            ),
        ),
      ).toBe(true),
    );
    expect(
      api.fetchMock.mock.calls
        .filter(([path]) => /^\/invoices\?/.test(path.toString()))
        .every(([path]) => path.toString().includes("organizationId=org-B")),
    ).toBe(true);
  });

  it("selects a loaded membership group and retains that context on the dashboard and invoices", async () => {
    const api = http();
    await start("Mis grupos");
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo 1" }),
    );
    navigate("Panel principal");
    expect(
      screen.getByRole("region", { name: "Tu espacio de trabajo" }).textContent,
    ).toContain("Academia BModalidadGrupo: Equipo 1");
    fireEvent.click(screen.getByRole("button", { name: "Ir a facturas" }));
    await screen.findByText("No hay facturas para este propietario.");
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        path
          .toString()
          .startsWith(
            "/invoices?organizationId=org-B&ownerType=group&ownerId=group-1",
          ),
      ),
    ).toBe(true);
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
      screen.getByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    expect(
      await screen.findByRole("region", {
        name: "Administración de plataforma",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Usar Organización externa" }),
    ).toBeNull();
    navigate("Mis grupos");
    expect(
      await screen.findByText(
        "Solo administración; no habilita un contexto de trabajo.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo externo" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Eliminar grupo Equipo externo" }),
    ).toBeTruthy();
    navigate("Panel principal");
    expect(
      screen.getByText("Elige una organización o grupo para empezar."),
    ).toBeTruthy();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        /^\/invoices\?/.test(path.toString()),
      ),
    ).toBe(false);
  });

  it("shows actual group loading/error/retry without presenting an empty list as confirmed", async () => {
    const api = http();
    const read = pending<Response>();
    api.readGroups.mockReturnValueOnce(read.promise);
    await start("Mis grupos");
    expect(screen.getByRole("status").textContent).toBe("Cargando grupos...");
    expect(screen.queryByText("No perteneces a grupos todavía.")).toBeNull();
    await act(async () => read.resolve(json({}, 500)));
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grupos" }));
    expect(
      await screen.findByRole("button", { name: "Trabajar con Equipo 0" }),
    ).toBeTruthy();
  });

  it("keeps failed admin form values, names the pending action and announces successful reconciliation", async () => {
    const api = http({
      ...profile,
      memberships: [{ organization: organizations[0], role: "ADMIN" }],
    });
    const change = pending<Response>();
    api.mutation.mockReturnValueOnce(change.promise);
    await start("Mis grupos");
    const edit = await screen.findByRole("textbox", {
      name: "Editar nombre de Equipo 0",
    });
    fireEvent.change(edit, { target: { value: "Equipo actualizado" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar grupo Equipo 0" }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Guardando grupo Equipo 0",
    );
    await act(async () => change.resolve(json({}, 403)));
    expect(screen.getByRole("alert").textContent).toContain(
      "No fue posible actualizar los grupos",
    );
    expect(edit).toHaveProperty("value", "Equipo actualizado");
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar grupo Equipo 0" }),
    );
    expect(
      await screen.findByText(
        "Cambio guardado. Los grupos se han actualizado.",
      ),
    ).toBeTruthy();
    expect(api.fetchMock).toHaveBeenCalledWith(
      "/organizations/org-A/groups/group-0",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          name: "Equipo actualizado",
          description: "Investigación aplicada",
        }),
      }),
    );
  });

  it.each([
    {
      action: "create",
      button: "Crear grupo en Academia A",
      method: "POST",
      path: "/organizations/org-A/groups",
      body: { name: "Nuevo equipo" },
    },
    {
      action: "add",
      button: "Agregar integrante a Equipo 0",
      method: "POST",
      path: "/organizations/org-A/groups/group-0/members",
      body: { userId: "new-member" },
    },
    {
      action: "remove",
      button: "Quitar a Ada de Equipo 0",
      method: "DELETE",
      path: "/organizations/org-A/groups/group-0/members/person",
      body: undefined,
    },
    {
      action: "delete",
      button: "Eliminar grupo Equipo 0",
      method: "DELETE",
      path: "/organizations/org-A/groups/group-0",
      body: undefined,
    },
  ])(
    "preserves the existing $action group contract and prevents a second pending mutation",
    async ({ action, button, method, path, body }) => {
      const api = http({
        ...profile,
        memberships: [{ organization: organizations[0], role: "ADMIN" }],
      });
      const mutation = pending<Response>();
      api.mutation.mockReturnValueOnce(mutation.promise);
      await start("Mis grupos");
      await screen.findByRole("button", { name: "Guardar grupo Equipo 0" });
      if (action === "create")
        fireEvent.change(
          screen.getByRole("textbox", { name: "Nuevo grupo en Academia A" }),
          { target: { value: "Nuevo equipo" } },
        );
      if (action === "add")
        fireEvent.change(
          screen.getByRole("textbox", {
            name: "ID de integrante para Equipo 0",
          }),
          { target: { value: "new-member" } },
        );
      const control = screen.getByRole("button", { name: button });
      fireEvent.click(control);
      expect(control).toHaveProperty("disabled", true);
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
      await act(async () => mutation.resolve(json({})));
      await screen.findByText(
        "Cambio guardado. Los grupos se han actualizado.",
      );
      expect(api.readGroups).toHaveBeenCalledTimes(2);
    },
  );

  it("distinguishes a committed mutation from a failed refresh and retries only the read", async () => {
    const api = http({
      ...profile,
      memberships: [{ organization: organizations[0], role: "ADMIN" }],
    });
    await start("Mis grupos");
    await screen.findByRole("button", { name: "Guardar grupo Equipo 0" });
    api.readGroups.mockResolvedValueOnce(json({}, 500));
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar grupo Equipo 0" }),
    );
    expect(
      await screen.findByText(
        "Cambio guardado. Reintenta la consulta para actualizar la lista; no repitas la operación.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Cambio guardado. Los grupos se han actualizado."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grupos" }));
    await screen.findByRole("button", { name: "Guardar grupo Equipo 0" });
    expect(api.mutation).toHaveBeenCalledTimes(1);
    expect(api.readGroups).toHaveBeenCalledTimes(3);
  });

  it("keeps a membership-free identity honest and does not manufacture group or invoice data", async () => {
    const api = http({ ...profile, memberships: [] });
    await start();
    expect(
      screen.getByText("Elige una organización o grupo para empezar."),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Ver mis organizaciones" }),
    );
    expect(
      screen.getByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    navigate("Mis grupos");
    expect(screen.getByText("No perteneces a grupos todavía.")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: /Crear grupo en|Trabajar con|Eliminar grupo/,
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
    navigate("Mis grupos");
    const name = await screen.findByRole<HTMLInputElement>("textbox", {
      name: "Nuevo grupo en Academia A",
    });
    for (const value of ["", "   "]) {
      fireEvent.change(name, { target: { value } });
      fireEvent.click(
        screen.getByRole("button", { name: "Crear grupo en Academia A" }),
      );
      expect(name.checkValidity()).toBe(false);
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
    expect(screen.getByRole("alert").textContent).toBe(
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
      screen.getByRole("heading", { name: "Mis membresías" }),
    ).toBeTruthy();
    expect(await screen.findByText("Organización externa")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Usar Academia B" }));
    navigate("Mis grupos");
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo 1" }),
    );
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo externo" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Eliminar grupo Equipo externo" }),
    ).toBeTruthy();
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
    navigate("Mis grupos");
    const heading = await within(
      screen.getByRole("region", { name: "Grupos de mis membresías" }),
    ).findByRole("heading", { name: longName, level: 3 });
    expect(getComputedStyle(heading).overflowWrap).toBe("anywhere");
    const card = heading.parentElement;
    if (!card) throw new Error("Missing group card");
    expect(getComputedStyle(card).minWidth).toBe("0px");
    expect(
      screen.getByRole("button", { name: `Guardar grupo ${longName}` }),
    ).toBeTruthy();
  });
});
