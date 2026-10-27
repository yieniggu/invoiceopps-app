import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  deferred,
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
const ada = profileFixture({ memberships: [membership(org, "ADMIN")] });
const bruno = profileFixture({
  id: "user-2",
  name: "Bruno Díaz",
  rut: "111111111",
  memberships: [],
});

describe("CR-107 late PATCH /profile after an identity swap", () => {
  it("does not write A's saved profile into B's cache or screen", async () => {
    let signedIn: "ada" | "bruno" = "ada";
    const patch = deferred<Response>();
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: signedIn === "ada" ? ada : bruno }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "PATCH /api/v1/profile": () => patch.promise,
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/login": () => {
        signedIn = "bruno";
        return jsonResponse({ user: {} });
      },
    });
    const { store } = renderApp({ route: "/perfil" });
    fireEvent.change(await screen.findByLabelText("Correo electrónico"), {
      target: { value: "ada-late@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "111111111" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "another-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Bruno Díaz/);
    const clientOfBruno = store.getSnapshot().client;

    await act(async () => {
      patch.resolve(
        jsonResponse({
          profile: { ...ada, email: "ada-late@example.test" },
        }),
      );
    });

    expect(screen.queryByText(/Ada Lovelace/)).toBeNull();
    expect(document.body.textContent).not.toContain("ada-late@example.test");
    expect(store.getSnapshot().client).toBe(clientOfBruno);
    expect(serializeClient(clientOfBruno)).not.toContain("ada-late");
    expect(serializeClient(clientOfBruno)).not.toContain("Ada Lovelace");
  });
});

describe("CR-107 group create re-submit", () => {
  // Accepted limitation: a response lost after the server created the group
  // may still be retried by the user and duplicate it, because group names are
  // not unique yet. Only the double submit within one request is guarded.
  it("sends one POST /groups when the form is submitted again while pending", async () => {
    const gate = deferred<Response>();
    const created = {
      id: "group-n",
      organizationId: "org-1",
      name: "Cobranza",
      description: null,
      permissions: {
        readInvoices: false,
        createInvoices: false,
        deleteOwnInvoices: false,
        deleteOthersInvoices: false,
      },
    };
    const base = "/api/v1/organizations/org-1";
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: ada }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [`GET ${base}/users`]: () => jsonResponse({ users: [] }),
      [`GET ${base}/groups`]: () => jsonResponse({ groups: [created] }),
      [`GET ${base}/groups/group-n/memberships`]: () =>
        jsonResponse({ memberships: [] }),
      [`POST ${base}/groups`]: () => gate.promise,
    });
    renderApp({ route: "/organizaciones/org-1/grupos/nuevo" });
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "Cobranza" },
    });
    const submit = screen.getByRole("button", { name: "Crear grupo" });
    const form = submit.closest("form") as HTMLFormElement;

    fireEvent.click(submit);
    fireEvent.click(submit);
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() =>
      expect(transport.calls(`POST ${base}/groups`)).toHaveLength(1),
    );
    await act(async () => gate.resolve(jsonResponse({ group: created }, 201)));
    await screen.findByText("Grupo «Cobranza» creado.");
    expect(transport.calls(`POST ${base}/groups`)).toHaveLength(1);
  });
});
