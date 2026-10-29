import { namedId } from "./test/ids";
import { membership, NO_PERMISSIONS } from "./test/transport";
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
  memberships: [membership(org, "ADMIN")],
};
const GROUP_ID = namedId("group", "g");
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
    id: GROUP_ID,
    organizationId: org.id,
    name: "Equipo ajeno",
    description: null,
  };
  // Another person who is always in the group: their flags can be edited.
  const carla = {
    userId: "00000000-0000-4000-8000-0000000000c1",
    groupId: GROUP_ID,
    organizationId: org.id,
    permissions: NO_PERMISSIONS,
    user: {
      id: "00000000-0000-4000-8000-0000000000c1",
      name: "Carla",
      rut: "190347907",
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
      // The platform directory lists every organization (paginated).
      if (path === "/api/v1/organizations")
        return json({
          organizations: [{ ...org, description: null }],
          page: 1,
          pageSize: 20,
          total: 1,
        });
      if (path === base && method === "GET")
        return json({
          organization: { ...org, description: null },
          summary: { memberCount: 1, groupCount: 1 },
        });
      if (
        path === `${base}/groups/${GROUP_ID}/memberships/bulk` &&
        method === "POST"
      )
        return json({ memberships: [] }, 201);
      if (path === `${base}/memberships` && method === "GET")
        return json({
          memberships: [
            {
              userId: actor,
              organizationId: org.id,
              role: "ADMIN",
              permissions: NO_PERMISSIONS,
              groups: [],
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
      if (path === `${base}/groups/${GROUP_ID}/memberships`)
        return method === "POST"
          ? json(
              {
                membership: {
                  userId: actor,
                  groupId: GROUP_ID,
                  organizationId: org.id,
                },
              },
              201,
            )
          : json({
              memberships: [
                ...(member
                  ? [
                      {
                        userId: actor,
                        groupId: GROUP_ID,
                        organizationId: org.id,
                        permissions: NO_PERMISSIONS,
                        user: self,
                      },
                    ]
                  : []),
                carla,
              ],
            });
      if (path === `${base}/groups/${GROUP_ID}/memberships/${actor}`) {
        member = false;
        return new Response(null, { status: 204 });
      }
      if (
        path ===
          `${base}/groups/${GROUP_ID}/memberships/00000000-0000-4000-8000-0000000000c1/permissions` &&
        method === "PUT"
      )
        return json({ membership: carla });
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
/** The organization summary, reached from the list. */
async function openOrganization() {
  navigate("Organizaciones");
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver detalle de Academia" }),
  );
}
/** The person's own page, reached through Miembros. */
async function openSelf() {
  fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
  fireEvent.click(await screen.findByRole("link", { name: "Persona" }));
  await screen.findByRole("heading", { level: 1, name: "Persona" });
}
async function start(destination: string) {
  const view = renderApp();
  await screen.findByRole("navigation");
  navigate(destination);
  return view;
}
async function removeSelf() {
  await openSelf();
  await screen.findByText(/12\.345\.678-5/);
  fireEvent.click(
    screen.getByRole("button", { name: "Quitar a Persona de la organización" }),
  );
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
      await screen.findByRole("link", { name: "Ver grupo Equipo ajeno" }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
    fireEvent.click(await screen.findByRole("link", { name: "Carla" }));
    const editor = await screen.findByRole("group", {
      name: "Permisos en el grupo «Equipo ajeno» — Carla",
    });
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
    expect(api.catalog).toHaveBeenCalled();
    // The write contracts of the screens, without ever joining the catalogue
    // group or adding a Workspace owner. Saving a member's flags leaves the
    // catalogue alone; membership writes and group creation refresh it.
    let reads = api.catalog.mock.calls.length;
    fireEvent.click(
      within(editor).getByRole("button", { name: "Leer facturas" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar permisos de Carla" }),
    );
    await screen.findByText("Permisos guardados");
    expect(api.catalog.mock.calls.length).toBe(reads);
    fireEvent.click(screen.getByRole("link", { name: "Miembros del grupo" }));
    fireEvent.click(
      await screen.findByRole("link", { name: "Agregar miembros" }),
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /Persona/ }));
    reads = api.catalog.mock.calls.length;
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
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
        `${base}/groups/${GROUP_ID}/memberships/00000000-0000-4000-8000-0000000000c1/permissions`,
        "PUT",
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
        `${base}/groups/${GROUP_ID}/memberships/bulk`,
        "POST",
        JSON.stringify({
          members: [{ userId: actor, permissions: NO_PERMISSIONS }],
        }),
      ],
      [`${base}/groups`, "POST", JSON.stringify({ name: "Intento original" })],
    ]);
    navigate("Grupos");
    await screen.findByRole("link", { name: "Ver grupo Equipo ajeno" });
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
  });

  it("CR009 ignores an older capability GET body after a newer same-session authority refresh", async () => {
    const api = http();
    const view = await start("Organizaciones");
    fireEvent.click(
      await screen.findByRole("link", { name: "Ver detalle de Academia" }),
    );
    await openSelf();
    await screen.findByText(/12\.345\.678-5/);
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
    fireEvent.click(
      screen.getByRole("button", {
        name: "Quitar a Persona de la organización",
      }),
    );
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
      await screen.findByRole("link", { name: "Ver grupo Equipo ajeno" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("link", { name: "Ver grupo Equipo ajeno" }),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
    fireEvent.click(await screen.findByRole("link", { name: "Persona" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Quitar a Persona del grupo" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar quitar a Persona" }),
    );
    await screen.findByText("Se quitó a Persona del grupo.");
    await waitFor(() => expect(api.readGroups).toHaveBeenCalledTimes(2));
    // The workspace catalogue was revalidated together with the membership.
    navigate("Grupos");
    await screen.findByRole("link", { name: "Ver grupo Equipo ajeno" });
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    expect(api.catalog.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.readGroups).toHaveBeenCalledTimes(2);
  });
});
