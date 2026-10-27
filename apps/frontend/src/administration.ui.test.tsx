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
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
  serializeClient,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const org = { id: "org-1", name: "Academia Norte" };
const admin = profileFixture({ memberships: [membership(org, "ADMIN")] });
const members = [
  {
    userId: "user-1",
    organizationId: "org-1",
    role: "ADMIN",
    user: { id: "user-1", name: "Ada Lovelace", rut: "123456785" },
  },
  {
    userId: "user-3",
    organizationId: "org-1",
    role: "USER",
    user: { id: "user-3", name: "Carla Soto", rut: "190347907" },
  },
];

function baseRoutes() {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": () =>
      jsonResponse({
        organizations: [
          {
            ...org,
            slug: "org-1",
            description: null,
            enabled: true,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    "GET /api/v1/organizations/org-1/memberships": () =>
      jsonResponse({ memberships: members }),
    "GET /api/v1/organizations/org-1/users": () =>
      jsonResponse({
        users: members.map(({ user, role }) => ({ ...user, role })),
      }),
  };
}

/** Opens the organization detail as a deep link, like a reload would. */
async function openAdministration() {
  await screen.findByRole("heading", { level: 1, name: "Academia Norte" });
}

describe("organization members (AC-11)", () => {
  it("lists members with canonical RUTs formatted for display", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    expect(screen.getByText("19.034.790-7")).toBeTruthy();
    expect(screen.getByText("12.345.678-5")).toBeTruthy();
  });

  it("changes a role with PATCH {role} and refetches only this organization's memberships", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "PATCH /api/v1/organizations/org-1/memberships/user-3": () =>
        jsonResponse({
          membership: {
            userId: "user-3",
            organizationId: "org-1",
            role: "ADMIN",
          },
        }),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    const select = await screen.findByLabelText("Rol de Carla Soto");
    fireEvent.change(select, { target: { value: "ADMIN" } });
    await waitFor(() =>
      expect(
        transport.calls("PATCH /api/v1/organizations/org-1/memberships/user-3"),
      ).toHaveLength(1),
    );
    expect(
      transport.calls("PATCH /api/v1/organizations/org-1/memberships/user-3")[0]
        .body,
    ).toEqual({ role: "ADMIN" });
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations/org-1/memberships"),
      ).toHaveLength(2),
    );
    // Another person's role does not touch the profile.
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(1);
  });

  it("announces LAST_ADMIN_REQUIRED accessibly and keeps the role unchanged", async () => {
    mockTransport({
      ...baseRoutes(),
      "PATCH /api/v1/organizations/org-1/memberships/user-1": () =>
        errorResponse(409, "LAST_ADMIN_REQUIRED"),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    const select = (await screen.findByLabelText(
      "Rol de Ada Lovelace",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "USER" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "No puedes quitar ni cambiar el rol del último administrador de la organización.",
    );
    expect(select.value).toBe("ADMIN");
  });

  it("removes a member with DELETE and refreshes the profile when the actor removes themselves", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/org-1/memberships/user-1": () =>
        new Response(null, { status: 204 }),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    const trigger = await screen.findByRole("button", {
      name: "Quitar a Ada Lovelace",
    });
    fireEvent.click(trigger);
    // Nothing is sent until the removal is confirmed.
    expect(
      transport.calls("DELETE /api/v1/organizations/org-1/memberships/user-1"),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Ada Lovelace" }),
    );
    await waitFor(() =>
      expect(
        transport.calls(
          "DELETE /api/v1/organizations/org-1/memberships/user-1",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
  });

  it("CR-109 marks this organization's group memberships stale after a removal, not another organization's", async () => {
    const groupKey = (organizationId: string, groupId: string) => [
      "identity",
      "user-1",
      "org",
      organizationId,
      "group",
      groupId,
      "memberships",
    ];
    mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/org-1/memberships/user-3": () =>
        new Response(null, { status: 204 }),
    });
    const { store } = renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    const client = store.getSnapshot().client;
    client.setQueryData(groupKey("org-1", "group-a"), { memberships: [] });
    client.setQueryData(groupKey("org-2", "group-z"), { memberships: [] });

    fireEvent.click(
      screen.getByRole("button", { name: "Quitar a Carla Soto" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );

    await waitFor(() =>
      expect(
        client.getQueryState(groupKey("org-1", "group-a"))?.isInvalidated,
      ).toBe(true),
    );
    expect(
      client.getQueryState(groupKey("org-2", "group-z"))?.isInvalidated,
    ).toBe(false);
  });

  it("assigns an existing person by RUT and resets the form", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/memberships": () =>
        jsonResponse(
          {
            membership: {
              userId: "user-4",
              organizationId: "org-1",
              role: "USER",
            },
          },
          201,
        ),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Asignar persona" }));
    await screen.findByText("Persona asignada a la organización.");
    expect(
      transport.calls("POST /api/v1/organizations/org-1/memberships")[0].body,
    ).toEqual({ rut: "19034790-7", role: "USER" });
    expect(
      (screen.getByLabelText(/RUT de la persona/) as HTMLInputElement).value,
    ).toBe("");
  });

  it("explains USER_NOT_FOUND for an unknown RUT", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/memberships": () =>
        errorResponse(404, "USER_NOT_FOUND"),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Asignar persona" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No existe una persona registrada con ese RUT.",
    );
  });
});

describe("user provisioning keeps the temporary password out of the cache (AC-11)", () => {
  const issued = "Tmp-Secret-4821-xyz";

  it("hands the secret to a dialog only, resolves metadata and resets the form", async () => {
    const gate = deferred<Response>();
    const transport = mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () => gate.promise,
    });
    const { store } = renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");

    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego Rojas" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    // Values were captured at submit: editing the form while the request is in
    // flight must not change what is sent.
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Otro nombre" },
    });
    gate.resolve(
      jsonResponse(
        {
          user: {
            id: "user-9",
            name: "Diego Rojas",
            rut: "111111111",
            mustChangePassword: true,
          },
          membership: {
            userId: "user-9",
            organizationId: "org-1",
            role: "USER",
          },
          temporaryPassword: issued,
        },
        201,
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(issued)).toBeTruthy();
    expect(
      transport.calls("POST /api/v1/organizations/org-1/users")[0].body,
    ).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      role: "USER",
    });
    expect(dialog.contains(document.activeElement)).toBe(true);

    const dump = serializeClient(store.getSnapshot().client);
    expect(dump).not.toContain(issued);
    expect(
      store.getSnapshot().client.getMutationCache().getAll(),
    ).not.toHaveLength(0);

    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations/org-1/memberships"),
      ).toHaveLength(2),
    );
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
    expect(serializeClient(store.getSnapshot().client)).not.toContain(issued);
  });

  it("closes the dialog with its button and returns focus to the submit button", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () =>
        jsonResponse(
          {
            user: {
              id: "user-9",
              name: "Diego",
              rut: "111111111",
              mustChangePassword: true,
            },
            membership: {
              userId: "user-9",
              organizationId: "org-1",
              role: "USER",
            },
            temporaryPassword: issued,
          },
          201,
        ),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    const submit = screen.getByRole("button", { name: "Crear usuario" });
    submit.focus();
    fireEvent.click(submit);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(submit);
  });

  it("keeps Tab inside the dialog and labels it for assistive technology", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () =>
        jsonResponse(
          {
            user: {
              id: "user-9",
              name: "Diego",
              rut: "111111111",
              mustChangePassword: true,
            },
            membership: {
              userId: "user-9",
              organizationId: "org-1",
              role: "USER",
            },
            temporaryPassword: issued,
          },
          201,
        ),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const close = within(dialog).getByRole("button", { name: "Cerrar" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("blocks the submit for an invalid RUT, names the problem and focuses the field", async () => {
    const transport = mockTransport(baseRoutes());
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    const rut = screen.getByLabelText(/RUT del usuario/) as HTMLInputElement;
    fireEvent.change(rut, { target: { value: "190347908" } });
    expect(rut.value).toBe("19.034.790-8");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    expect(screen.getByText("RUT inválido")).toBeTruthy();
    expect(document.activeElement).toBe(rut);
    expect(
      transport.calls("POST /api/v1/organizations/org-1/users"),
    ).toHaveLength(0);
  });

  it("keeps the typed values and speaks Spanish on a network failure", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () => {
        throw new TypeError("offline");
      },
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No fue posible conectar con el servidor/,
    );
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("Diego");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks this organization's users stale after provisioning, leaving other organizations alone", async () => {
    const { store } = (() => {
      mockTransport({
        ...baseRoutes(),
        "POST /api/v1/organizations/org-1/users": () =>
          jsonResponse(
            {
              user: {
                id: "user-9",
                name: "Diego",
                rut: "111111111",
                mustChangePassword: true,
              },
              membership: {
                userId: "user-9",
                organizationId: "org-1",
                role: "USER",
              },
              temporaryPassword: "Tmp-Secret-1",
            },
            201,
          ),
      });
      return renderApp({ route: "/organizaciones/org-1" });
    })();
    await openAdministration();
    await screen.findByText("Carla Soto");
    const client = store.getSnapshot().client;
    client.setQueryData(["identity", "user-1", "org", "org-1", "users"], []);
    client.setQueryData(["identity", "user-1", "org", "org-2", "users"], []);
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    await screen.findByRole("dialog");
    const stale = (org: string) =>
      client.getQueryState(["identity", "user-1", "org", org, "users"])
        ?.isInvalidated;
    await waitFor(() => expect(stale("org-1")).toBe(true));
    expect(stale("org-2")).toBe(false);
  });

  it("reports USER_CONFLICT without opening a dialog", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () =>
        errorResponse(409, "USER_CONFLICT"),
    });
    renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ya existe un usuario con ese RUT.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CR-104 issued credential survives navigation within the identity", () => {
  const issued = "Tmp-Secret-4821-xyz";
  const created = () =>
    jsonResponse(
      {
        user: {
          id: "user-9",
          name: "Diego Rojas",
          rut: "111111111",
          mustChangePassword: true,
        },
        membership: { userId: "user-9", organizationId: "org-1", role: "USER" },
        temporaryPassword: issued,
      },
      201,
    );

  async function startPending() {
    const gate = deferred<Response>();
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/org-1/users": () => gate.promise,
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    const view = renderApp({ route: "/organizaciones/org-1" });
    await openAdministration();
    await screen.findByText("Carla Soto");
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego Rojas" },
    });
    fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    fireEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", {
        name: "Mi perfil",
      }),
    );
    await screen.findByRole("heading", { name: "Mi perfil" });
    return { ...view, gate };
  }

  it("shows the password when the response arrives after leaving the screen", async () => {
    const { gate, store } = await startPending();
    gate.resolve(created());

    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(issued)).toBeTruthy();
    expect(serializeClient(store.getSnapshot().client)).not.toContain(issued);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });

  it("clears the dialog on logout and ignores a response arriving afterwards", async () => {
    const { gate } = await startPending();
    gate.resolve(created());
    await screen.findByRole("dialog", { name: "Contraseña temporal" });

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });

  it("never shows a password that arrives after logout", async () => {
    const { gate } = await startPending();
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });

    await act(async () => gate.resolve(created()));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });
});
