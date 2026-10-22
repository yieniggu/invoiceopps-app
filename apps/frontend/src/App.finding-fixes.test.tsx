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
import { App } from "./App";
import type { Profile } from "./features/profile/ProfileScreen";
import type { Group } from "./features/groups/GroupsScreen";
import { normalizeGroupIntent } from "./features/groups/groupOperations";

const org = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Academia",
  slug: "academy",
};
const actor = "00000000-0000-4000-8000-000000000002";
const initial: Profile = {
  id: actor,
  name: "Persona",
  rut: "123456785",
  email: null,
  username: null,
  isPlatformAdministrator: true,
  memberships: [{ organization: org, role: "ADMIN" }],
};
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
    within(screen.getByRole("navigation")).getByRole("button", { name }),
  );
}
function http(platform = true) {
  let profile = { ...initial, isPlatformAdministrator: platform };
  const reads = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const patch = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const create = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({}, 201));
  const logout = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => new Response(null, { status: 204 }));
  let member = false;
  const group = {
    id: "g",
    name: "Equipo ajeno",
    description: null,
    organization: org,
  };
  const catalog = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({ groups: [group], nextCursor: null }),
    );
  const readGroups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        groups: member
          ? [
              {
                ...group,
                members: [{ id: actor, name: "Persona", rut: "123456785" }],
              },
            ]
          : [],
      }),
    );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://test.invalid").pathname;
      if (path === "/profile")
        return init?.method === "PATCH" ? patch() : reads();
      if (path === "/groups") return readGroups();
      if (path === "/platform/organizations")
        return json({ organizations: [{ ...org, groups: [] }] });
      if (path.startsWith("/platform/organizations/")) {
        profile = { ...profile, memberships: [] };
        return new Response(null, { status: 204 });
      }
      if (path === `/organizations/${org.id}/groups`)
        return init?.method === "POST" ? create() : catalog();
      if (path.startsWith(`/organizations/${org.id}/groups/`)) {
        if (init?.method === "DELETE") member = false;
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({});
      }
      if (path === "/auth/logout") return logout();
      if (path === "/auth/login") return json({});
      throw new Error(`Unexpected request ${path}`);
    });
  return {
    reads,
    patch,
    create,
    logout,
    catalog,
    readGroups,
    fetchMock,
    setProfile: (next: Profile) => {
      profile = next;
    },
    member: () => {
      member = true;
    },
  };
}
async function start(destination: string) {
  render(<App />);
  await screen.findByRole("navigation");
  navigate(destination);
}
function removeSelf() {
  fireEvent.change(screen.getByLabelText("Organización administrada"), {
    target: { value: org.id },
  });
  fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
    target: { value: actor },
  });
  fireEvent.change(screen.getByLabelText("Operación de membresía"), {
    target: { value: "DELETE" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Revisar operación" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirmar operación" }));
}
function createGroup() {
  fireEvent.change(screen.getByLabelText("Nuevo grupo en Academia"), {
    target: { value: "Intento original" },
  });
  fireEvent.submit(
    screen.getByRole("form", { name: "Crear grupo en Academia" }),
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
    navigate("Administración");
    removeSelf();
    await screen.findByText(/Operación confirmada/);
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
    expect(
      screen.getByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Contexto de trabajo").textContent).toContain(
      "Contexto no disponible",
    );
  });
  it("CR010 lazily catalogs non-member groups for an organization ADMIN without granting workspace ownership", async () => {
    const api = http(false);
    await start("Mi perfil");
    expect(api.catalog).not.toHaveBeenCalled();
    navigate("Mis grupos");
    fireEvent.change(
      screen.getByLabelText("Organización del catálogo de grupos"),
      { target: { value: org.id } },
    );
    await screen.findByRole("button", { name: "Guardar grupo Equipo ajeno" });
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeNull();
    expect(screen.getByText(/Integrantes no consultados/)).toBeTruthy();
    expect(api.catalog).toHaveBeenCalledOnce();
    // Exercise the existing five write contracts through the actual App UI,
    // without ever joining the catalog group or adding a Workspace owner.
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar grupo Equipo ajeno" }),
    );
    await screen.findByText(/Cambio guardado/);
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(2));
    fireEvent.change(
      screen.getByLabelText("ID de integrante para Equipo ajeno"),
      { target: { value: actor } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar integrante a Equipo ajeno" }),
    );
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(3));
    fireEvent.change(
      screen.getByLabelText("UUID de integrante para quitar de Equipo ajeno"),
      { target: { value: actor } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar integrante de Equipo ajeno" }),
    );
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(4));
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar grupo Equipo ajeno" }),
    );
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(5));
    createGroup();
    await waitFor(() => expect(api.catalog).toHaveBeenCalledTimes(6));
    const writes = api.fetchMock.mock.calls.filter(
      ([path, init]) =>
        String(path).startsWith(`/organizations/${org.id}/groups`) &&
        init?.method,
    );
    expect(
      writes.map(([path, init]) => [String(path), init?.method, init?.body]),
    ).toEqual([
      [
        `/organizations/${org.id}/groups/g`,
        "PATCH",
        JSON.stringify({ name: "Equipo ajeno", description: "" }),
      ],
      [
        `/organizations/${org.id}/groups/g/members`,
        "POST",
        JSON.stringify({ userId: actor }),
      ],
      [
        `/organizations/${org.id}/groups/g/members/${actor}`,
        "DELETE",
        undefined,
      ],
      [`/organizations/${org.id}/groups/g`, "DELETE", undefined],
      [
        `/organizations/${org.id}/groups`,
        "POST",
        JSON.stringify({ name: "Intento original" }),
      ],
    ]);
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeNull();
  });
  it("CR009 ignores an older capability GET body after a newer same-session authority refresh", async () => {
    const api = http();
    await start("Administración");
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.reads.mockResolvedValueOnce(response);
    fireEvent.change(screen.getByLabelText("Organización administrada"), {
      target: { value: org.id },
    });
    fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
      target: { value: "00000000-0000-4000-8000-000000000003" },
    });
    fireEvent.change(screen.getByLabelText("Operación de membresía"), {
      target: { value: "DELETE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar operación" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar operación" }),
    );
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    removeSelf();
    await screen.findByText(/Operación confirmada/);
    await act(async () => body.resolve({ profile: initial }));
    navigate("Mi perfil");
    expect(
      screen.getByText("No tienes organizaciones asignadas."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Contexto de trabajo").textContent).toContain(
      "Contexto no disponible",
    );
  });
  it("CR010 refreshes actual memberships and the selected catalog after self group removal without duplicate cards", async () => {
    const api = http(false);
    api.member();
    await start("Mis grupos");
    fireEvent.change(
      screen.getByLabelText("Organización del catálogo de grupos"),
      { target: { value: org.id } },
    );
    await waitFor(() => expect(api.catalog).toHaveBeenCalledOnce());
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar a Persona de Equipo ajeno" }),
    );
    await screen.findByText(/Cambio guardado/);
    await screen.findByText(/Integrantes no consultados/);
    expect(
      screen.getAllByRole("heading", { name: "Equipo ajeno" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Trabajar con Equipo ajeno" }),
    ).toBeNull();
    expect(api.catalog).toHaveBeenCalledTimes(2);
  });
  it("CR011 retains a lost-header committed creation across navigation and failed logout, without a duplicate POST", async () => {
    const api = http(false);
    let committed = 0;
    api.create.mockImplementationOnce(async () => {
      committed += 1;
      throw new Error("Response lost before headers");
    });
    await start("Mis grupos");
    createGroup();
    await screen.findByText(/resultado es desconocido/i);
    navigate("Mi perfil");
    navigate("Mis grupos");
    createGroup();
    api.logout.mockRejectedValueOnce(new Error("Logout failed"));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByText(/No fue posible cerrar la sesión/);
    createGroup();
    expect(committed).toBe(1);
    expect(api.create).toHaveBeenCalledOnce();
    expect(screen.getByText(/resultado es desconocido/i)).toBeTruthy();
  });
  it("CR011 permits correction after a known 4xx rejection", async () => {
    const api = http(false);
    api.create.mockResolvedValueOnce(json({}, 400));
    await start("Mis grupos");
    createGroup();
    await screen.findByText(/No fue posible actualizar los grupos/);
    createGroup();
    await screen.findByText(/Cambio guardado/);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
  it("CR011 retains known 2xx acknowledgement when the refresh fails and retries only reads", async () => {
    const api = http(false);
    await start("Mis grupos");
    await waitFor(() => expect(api.readGroups).toHaveBeenCalledOnce());
    api.readGroups.mockResolvedValueOnce(json({}, 500));
    createGroup();
    await screen.findByText(/Cambio guardado.*no repitas la operación/);
    expect(
      screen.getByRole("button", { name: "Crear grupo en Academia" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grupos" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Crear grupo en Academia" }),
      ).toHaveProperty("disabled", false),
    );
    expect(api.create).toHaveBeenCalledOnce();
  });
  it("CR009 isolates a delayed old contact body from a new actor session", async () => {
    const api = http();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.patch.mockResolvedValueOnce(response);
    await start("Mi perfil");
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    api.setProfile({
      ...initial,
      id: "B",
      name: "Persona B",
      email: "b@example.test",
      memberships: [],
    });
    fireEvent.change(screen.getByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByRole("navigation");
    await act(async () =>
      body.resolve({ profile: { ...initial, email: "old@example.test" } }),
    );
    navigate("Mi perfil");
    expect(screen.getByText("Persona B")).toBeTruthy();
    expect(screen.getByLabelText("Correo electrónico")).toHaveProperty(
      "value",
      "b@example.test",
    );
  });
  it("CR011 does not release a creation lock using a catalog read, but resets it after a legitimate same-user login", async () => {
    const api = http(false);
    const pending = deferred<Response>();
    api.create.mockReturnValueOnce(pending.promise);
    await start("Mis grupos");
    createGroup();
    api.logout.mockRejectedValueOnce(new Error("Logout failed"));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByText(/No fue posible cerrar la sesión/);
    await screen.findByText(/resultado es desconocido/i);
    fireEvent.change(
      screen.getByLabelText("Organización del catálogo de grupos"),
      { target: { value: org.id } },
    );
    await screen.findByText(/Integrantes no consultados/);
    await act(async () => pending.resolve(json({}, 401)));
    createGroup();
    expect(api.create).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByRole("navigation");
    navigate("Mis grupos");
    createGroup();
    await screen.findByText(/Cambio guardado/);
    expect(api.create).toHaveBeenCalledTimes(2);
  });
});

const memberA = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
const memberB = "abcdefab-cdef-4abc-8abc-abcdefabcdee";
function membershipHttp() {
  const api = http(false);
  const members = new Map<string, Group["members"][number]>([
    [actor, { id: actor, name: "Persona", rut: "123456785" }],
  ]);
  api.readGroups.mockImplementation(async () =>
    json({
      groups: [
        {
          id: "g",
          name: "Equipo ajeno",
          description: null,
          organization: org,
          members: [...members.values()],
        },
      ],
    }),
  );
  const write = vi
    .fn<(path: string, init: RequestInit) => Promise<Response>>()
    .mockImplementation(async (path, init) => {
      if (init.method === "POST") {
        const input: unknown = JSON.parse(String(init.body));
        if (
          !input ||
          typeof input !== "object" ||
          !("userId" in input) ||
          typeof input.userId !== "string"
        )
          return json({}, 400);
        const userId = input.userId.trim();
        if (members.has(userId)) return json({}, 409);
        // The HTTP fixture commits the native server's semantic target, then loses
        // the transport BEFORE returning a Response/acknowledgement to App.
        members.set(userId, {
          id: userId,
          name: `Integrante ${userId}`,
          rut: "123456793",
        });
        throw new Error("Committed membership; response lost before headers");
      }
      members.delete(decodeURIComponent(path.split("/").at(-1) ?? ""));
      return new Response(null, { status: 204 });
    });
  const original = api.fetchMock.getMockImplementation()!;
  api.fetchMock.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "http://test.invalid").pathname;
    if (
      path.startsWith(`/organizations/${org.id}/groups/g/members`) &&
      init?.method
    )
      return write(path, init);
    return original(input, init);
  });
  return { ...api, write, members };
}
function submitMember(userId: string) {
  fireEvent.change(
    screen.getByLabelText("ID de integrante para Equipo ajeno"),
    { target: { value: userId } },
  );
  // Force the real form handler even when its submit button is disabled. This
  // verifies the session owner's lock, not just unreachable UI controls.
  fireEvent.submit(
    screen.getByRole("form", { name: "Agregar integrante a Equipo ajeno" }),
  );
}
describe("CR011 residual membership identity", () => {
  it("canonicalizes member request intent and shared ADD/REMOVE keys by trim only, retaining identifier case", () => {
    const path = `/organizations/${org.id}/groups/g/members`;
    const added = normalizeGroupIntent({
      path,
      method: "POST",
      body: JSON.stringify({ userId: ` ${memberA} ` }),
    });
    const removed = normalizeGroupIntent({
      path: `${path}/${encodeURIComponent(` ${memberA} `)}`,
      method: "DELETE",
    });
    expect(added?.key).toBe(`${path}/${memberA}`);
    expect(removed?.key).toBe(added?.key);
    expect(added?.intent.body).toBe(JSON.stringify({ userId: memberA }));
    expect(removed?.intent.path).toBe(added?.key);
    const uppercase = normalizeGroupIntent({
      path,
      method: "POST",
      body: JSON.stringify({ userId: memberA.toUpperCase() }),
    });
    expect(uppercase?.key).toBe(`${path}/${memberA.toUpperCase()}`);
    expect(uppercase?.key).not.toBe(added?.key);
    expect(
      normalizeGroupIntent({
        path: `/organizations/${org.id}/groups`,
        method: "POST",
        body: JSON.stringify({ name: "Another name" }),
      })?.key,
    ).toBe(`/organizations/${org.id}/groups`);
  });
  it("rejects invalid member bodies and malformed URI input without throwing or allocating an identity", () => {
    const path = `/organizations/${org.id}/groups/g/members`;
    for (const body of [
      "{",
      "null",
      "[]",
      "{}",
      '{"userId":1}',
      '{"userId":"  "}',
      '{"userId":"x","extra":true}',
      JSON.stringify({ userId: "\ud800" }),
    ]) {
      expect(normalizeGroupIntent({ path, method: "POST", body })).toBeNull();
    }
    expect(
      normalizeGroupIntent({ path: `${path}/%`, method: "DELETE" }),
    ).toBeNull();
    expect(
      normalizeGroupIntent({ path: `${path}/%20`, method: "DELETE" }),
    ).toBeNull();
  });
  it("blocks a whitespace alias in the actual form handler after a canonical POST commits but loses headers", async () => {
    const api = membershipHttp();
    await start("Mis grupos");
    await screen.findByRole("form", {
      name: "Agregar integrante a Equipo ajeno",
    });
    submitMember(memberA);
    await screen.findByText(/resultado es desconocido/i);
    expect(api.members.has(memberA)).toBe(true);
    submitMember(` ${memberA} `);
    await act(async () => {});
    expect(api.write).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText("ID de integrante para Equipo ajeno"),
    ).toHaveProperty("value", ` ${memberA} `);
    navigate("Mi perfil");
    navigate("Mis grupos");
    fireEvent.change(
      screen.getByLabelText("Organización del catálogo de grupos"),
      { target: { value: org.id } },
    );
    await waitFor(() => expect(api.catalog).toHaveBeenCalledOnce());
    submitMember(` ${memberA} `);
    expect(api.write).toHaveBeenCalledOnce();
    expect(screen.getByText(/resultado es desconocido/i)).toBeTruthy();
  });
  it("shares a spaced POST lock with canonical roster DELETE after an authoritative MyGroups read", async () => {
    const api = membershipHttp();
    api.readGroups.mockResolvedValueOnce(json({}, 500));
    await start("Mis grupos");
    await screen.findByRole("button", { name: "Reintentar grupos" });
    fireEvent.change(
      screen.getByLabelText("Organización del catálogo de grupos"),
      { target: { value: org.id } },
    );
    await screen.findByRole("form", {
      name: "Agregar integrante a Equipo ajeno",
    });
    submitMember(` ${memberA} `);
    await screen.findByText(/resultado es desconocido/i);
    expect(api.members.has(memberA)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar grupos" }));
    const remove = await screen.findByRole("button", {
      name: `Quitar a Integrante ${memberA} de Equipo ajeno`,
    });
    expect(remove).toHaveProperty("disabled", true);
    fireEvent.click(remove);
    submitMember(memberA);
    expect(api.write).toHaveBeenCalledOnce();
    expect(api.write.mock.calls[0][1].body).toBe(
      JSON.stringify({ userId: memberA }),
    );
    expect(screen.getByText(/resultado es desconocido/i)).toBeTruthy();
  });
  it("retains two independent unknown members with unique React keys and visible canonical targets", async () => {
    const api = membershipHttp();
    const errors = vi.spyOn(console, "error");
    await start("Mis grupos");
    await screen.findByRole("form", {
      name: "Agregar integrante a Equipo ajeno",
    });
    submitMember(memberA);
    await screen.findByText(/resultado es desconocido/i);
    submitMember(memberB);
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(api.write).toHaveBeenCalledTimes(2);
    expect([...api.members.keys()]).toEqual([actor, memberA, memberB]);
    expect(
      errors.mock.calls.filter((args) =>
        args.some((arg) => String(arg).includes("same key")),
      ),
    ).toEqual([]);
    const alerts = screen.getAllByRole("alert");
    expect(
      alerts.filter((alert) => alert.textContent?.includes(memberA)),
    ).toHaveLength(1);
    expect(
      alerts.filter((alert) => alert.textContent?.includes(memberB)),
    ).toHaveLength(1);
    navigate("Mi perfil");
    navigate("Mis grupos");
    submitMember(` ${memberA} `);
    submitMember(` ${memberB} `);
    expect(api.write).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});
