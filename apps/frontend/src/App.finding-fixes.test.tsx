import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "./features/profile/ProfileScreen";
import { renderApp } from "./test/renderApp";

const org = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Academia",
  slug: "academy",
};
const actor = "00000000-0000-4000-8000-000000000002";
const initial: Profile = {
  id: actor,
  name: "Persona",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: true,
  memberships: [{ organization: org, role: "ADMIN" }],
};
const base = `/api/v1/organizations/${org.id}`;
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
// The active context is observable on the dashboard "Tu espacio de trabajo" card.
function dashboardContext() {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", {
      name: "Panel principal",
    }),
  );
  return screen.getByRole("region", { name: "Tu espacio de trabajo" });
}
function http(platform = true) {
  let profile = { ...initial, isPlatformAdministrator: platform };
  const reads = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const patch = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  let member = false;
  const group = {
    id: "g",
    organizationId: org.id,
    name: "Equipo ajeno",
    description: null,
    permissions: {
      readInvoices: false,
      createInvoices: false,
      deleteOwnInvoices: false,
      deleteOthersInvoices: false,
    },
  };
  const catalog = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: [group] }));
  const readGroups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        groups: member
          ? [
              {
                id: group.id,
                name: group.name,
                description: null,
                organization: org,
                members: [{ id: actor, name: "Persona", rut: "12345678-5" }],
              },
            ]
          : [],
      }),
    );
  const self = { id: actor, name: "Persona", rut: "123456785" };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://test.invalid").pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/auth/profile" || path === "/api/v1/profile")
        return method === "PATCH" ? patch() : reads();
      if (path === "/api/v1/groups") return readGroups();
      if (path === "/api/v1/organizations") return json({ organizations: [] });
      if (path === `${base}/memberships` && method === "GET")
        return json({
          memberships: [
            {
              userId: actor,
              organizationId: org.id,
              role: "ADMIN",
              user: self,
            },
          ],
        });
      if (path === `${base}/memberships/${actor}` && method === "DELETE") {
        profile = { ...profile, memberships: [] };
        return new Response(null, { status: 204 });
      }
      if (path === `${base}/users`)
        return json({ users: [{ ...self, role: "ADMIN" }] });
      if (path === `${base}/groups`)
        return method === "POST" ? json({ group }, 201) : catalog();
      if (path === `${base}/groups/g/memberships`)
        return method === "POST"
          ? json(
              {
                membership: {
                  userId: actor,
                  groupId: "g",
                  organizationId: org.id,
                },
              },
              201,
            )
          : json({
              memberships: member
                ? [
                    {
                      userId: actor,
                      groupId: "g",
                      organizationId: org.id,
                      user: self,
                    },
                  ]
                : [],
            });
      if (path === `${base}/groups/g/memberships/${actor}`) {
        member = false;
        return new Response(null, { status: 204 });
      }
      if (path === `${base}/groups/g` && method === "PATCH")
        return json({ group });
      throw new Error(`Unexpected request ${method} ${path}`);
    });
  return {
    reads,
    patch,
    catalog,
    readGroups,
    fetchMock,
    member: () => {
      member = true;
    },
  };
}
/** People are managed on the organization detail, reached from the list. */
async function openOrganization() {
  navigate("Organizaciones");
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver detalle de Academia" }),
  );
}
async function start(destination: string) {
  const view = renderApp();
  await screen.findByRole("navigation");
  navigate(destination);
  return view;
}
async function removeSelf() {
  await screen.findByText("12.345.678-5");
  fireEvent.click(screen.getByRole("button", { name: "Quitar a Persona" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirmar quitar a Persona" }),
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FULLAPP12 authorized findings", () => {
  it("CR009 never restores capabilities from a delayed contact PATCH body after self removal", async () => {
    const api = http();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.patch.mockResolvedValueOnce(response);
    await start("Mi perfil");
    fireEvent.change(screen.getByLabelText("Correo electrónico"), {
      target: { value: "confirmed@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    await openOrganization();
    await removeSelf();
    await waitFor(() =>
      expect(api.reads.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    navigate("Mi perfil");
    expect(screen.getByLabelText("Correo electrónico")).toHaveProperty(
      "value",
      "confirmed@example.test",
    );
    await act(async () =>
      body.resolve({
        profile: { ...initial, email: "confirmed@example.test" },
      }),
    );
    // The late body only carries contact data: memberships stay revoked.
    expect(
      await screen.findByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    expect(dashboardContext().textContent).toContain(
      "Elige una organización o grupo para empezar.",
    );
  });

  it("CR010 lazily catalogs non-member groups for an organization ADMIN without granting workspace ownership", async () => {
    const api = http(false);
    await start("Mi perfil");
    expect(api.catalog).not.toHaveBeenCalled();
    navigate("Grupos");
    fireEvent.click(
      await screen.findByRole("link", { name: "Ver detalle de Equipo ajeno" }),
    );
    const editor = await screen.findByRole("group", {
      name: "Permisos sobre facturas",
    });
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeNull();
    expect(api.catalog).toHaveBeenCalled();
    // The write contracts of the screen, without ever joining the catalogue
    // group or adding a Workspace owner. Each write refreshes the catalogue.
    let reads = api.catalog.mock.calls.length;
    fireEvent.click(
      within(editor).getByRole("checkbox", { name: "Leer facturas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    await screen.findByText("Permisos guardados.");
    await waitFor(() =>
      expect(api.catalog.mock.calls.length).toBeGreaterThan(reads),
    );
    await screen.findByRole("option", { name: "Persona" });
    reads = api.catalog.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Agregar al grupo" }));
    await waitFor(() =>
      expect(api.catalog.mock.calls.length).toBeGreaterThan(reads),
    );
    navigate("Grupos");
    fireEvent.click(
      await screen.findByRole("link", { name: "Crear grupo en Academia" }),
    );
    reads = api.catalog.mock.calls.length;
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "Intento original" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
    await waitFor(() =>
      expect(api.catalog.mock.calls.length).toBeGreaterThan(reads),
    );
    const writes = api.fetchMock.mock.calls.filter(
      ([path, init]) =>
        String(path).startsWith(`${base}/groups`) && init?.method !== "GET",
    );
    expect(
      writes.map(([path, init]) => [String(path), init?.method, init?.body]),
    ).toEqual([
      [
        `${base}/groups/g`,
        "PATCH",
        JSON.stringify({
          permissions: {
            readInvoices: true,
            createInvoices: false,
            deleteOwnInvoices: false,
            deleteOthersInvoices: false,
          },
        }),
      ],
      [
        `${base}/groups/g/memberships`,
        "POST",
        JSON.stringify({ userId: actor }),
      ],
      [`${base}/groups`, "POST", JSON.stringify({ name: "Intento original" })],
    ]);
    navigate("Grupos");
    await screen.findByRole("link", { name: "Ver detalle de Equipo ajeno" });
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeNull();
  });

  it("CR009 ignores an older capability GET body after a newer same-session authority refresh", async () => {
    const api = http();
    const view = await start("Organizaciones");
    fireEvent.click(
      await screen.findByRole("link", { name: "Ver detalle de Academia" }),
    );
    await screen.findByText("12.345.678-5");
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.reads.mockResolvedValueOnce(response);
    // An older refresh is still reading its body...
    act(() => {
      void view.store.getSnapshot().client.invalidateQueries({
        queryKey: ["identity", actor, "profile"],
        exact: true,
      });
    });
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    // ...when a newer authority change (self removal) refreshes the profile.
    fireEvent.click(screen.getByRole("button", { name: "Quitar a Persona" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Persona" }),
    );
    await waitFor(() =>
      expect(api.reads.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await act(async () => body.resolve({ profile: initial }));
    navigate("Mi perfil");
    expect(
      await screen.findByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    expect(dashboardContext().textContent).toContain(
      "Elige una organización o grupo para empezar.",
    );
  });

  it("CR010 refreshes actual memberships and the selected catalog after self group removal without duplicate cards", async () => {
    const api = http(false);
    api.member();
    await start("Grupos");
    await waitFor(() => expect(api.catalog).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("link", { name: "Ver detalle de Equipo ajeno" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Quitar a Persona del grupo" }),
    );
    await screen.findByText("Persona quitada del grupo.");
    await waitFor(() => expect(api.readGroups).toHaveBeenCalledTimes(2));
    // Workspace ownership is revoked together with the membership.
    navigate("Grupos");
    await screen.findByRole("link", { name: "Ver detalle de Equipo ajeno" });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
      ).toBeNull(),
    );
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    expect(api.catalog.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.readGroups).toHaveBeenCalledTimes(2);
  });
});
