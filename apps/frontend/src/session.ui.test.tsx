import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  deferred,
  errorResponse,
  jsonResponse,
  organizationsPage,
  membership,
  mockTransport,
  profileFixture,
  serializeClient,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const org = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const ada = profileFixture({ memberships: [membership(org, "USER")] });
const bruno = profileFixture({
  id: "00000000-0000-4000-8000-000000000002",
  name: "Bruno Díaz",
  rut: "111111111",
  memberships: [
    membership(
      { id: "00000000-0000-4000-9000-000000000002", name: "Instituto Sur" },
      "USER",
    ),
  ],
});

const temporary = "temporary-password-1";
const replacement = "replacement-password-9";

/** Queries that hold data; an idle, disabled observer may leave an empty shell. */
function dataOf(client: {
  getQueryCache(): { getAll(): Array<{ state: { data: unknown } }> };
}) {
  return client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined);
}

function fillLogin(rut: string, password: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
    target: { value: rut },
  });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
}

describe("QueryClient identity partition (AC-09, AC-10)", () => {
  it("never renders a frame of identity A after logout and login of B", async () => {
    let signedIn: "ada" | "bruno" | null = "ada";
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        signedIn === "ada"
          ? jsonResponse({ profile: ada })
          : signedIn === "bruno"
            ? jsonResponse({ profile: bruno })
            : errorResponse(401, "UNAUTHENTICATED"),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/auth/logout": () => {
        signedIn = null;
        return new Response(null, { status: 204 });
      },
      "POST /api/v1/auth/login": () => {
        signedIn = "bruno";
        return jsonResponse({ user: {} });
      },
    });
    const { store } = renderApp();
    await screen.findByRole("heading", { name: "Panel principal" });
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
    const clientOfAda = store.getSnapshot().client;

    const frames: string[] = [];
    const observer = new MutationObserver(() =>
      frames.push(document.body.textContent ?? ""),
    );
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fillLogin("111111111", "another-password-1");
    await screen.findByText(/Bruno Díaz/);
    await act(async () => {});
    observer.disconnect();

    expect(frames.length).toBeGreaterThan(0);
    const afterLogout = frames.slice(
      frames.findIndex((frame) => frame.includes("Iniciar sesión")),
    );
    expect(afterLogout.some((frame) => frame.includes("Ada Lovelace"))).toBe(
      false,
    );
    expect(afterLogout.some((frame) => frame.includes("Academia Norte"))).toBe(
      false,
    );
    expect(store.getSnapshot().client).not.toBe(clientOfAda);
    expect(clientOfAda.getQueryCache().getAll()).toHaveLength(0);
    expect(clientOfAda.getMutationCache().getAll()).toHaveLength(0);
    expect(transport.unexpected).toEqual([]);
  });

  it("swaps the partition when a focus refetch answers with another person", async () => {
    let answer = ada;
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: answer }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    const { store } = renderApp();
    await screen.findByText(/Ada Lovelace/);
    const first = store.getSnapshot();
    expect(first.phase).toBe("identity");
    expect(first.identityId).toBe("00000000-0000-4000-8000-000000000001");

    answer = bruno;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await screen.findByText(/Bruno Díaz/);
    // Bruno's name can first show from the refetch answer held by Ada's own
    // client; the partition swap (and the clearing of Ada's client) happens in
    // the effect that follows. Wait for the swap itself, not for the text.
    await waitFor(() =>
      expect(store.getSnapshot().identityId).toBe(
        "00000000-0000-4000-8000-000000000002",
      ),
    );
    expect(screen.queryByText(/Ada Lovelace/)).toBeNull();
    const second = store.getSnapshot();
    expect(second.client).not.toBe(first.client);
    expect(first.client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("refetches the profile on window focus", async () => {
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: ada }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp();
    await screen.findByText(/Ada Lovelace/);
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(1);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
  });

  it("ignores a late profile answer that arrives after logout", async () => {
    const late = deferred<Response>();
    let profileReads = 0;
    mockTransport({
      "GET /api/v1/auth/profile": () => {
        profileReads += 1;
        return profileReads === 1
          ? jsonResponse({ profile: ada })
          : late.promise;
      },
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    const { store } = renderApp();
    await screen.findByText(/Ada Lovelace/);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(profileReads).toBe(2));

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await act(async () => {
      late.resolve(jsonResponse({ profile: bruno }));
    });

    expect(
      screen.getByRole("heading", { name: "Iniciar sesión" }),
    ).toBeTruthy();
    expect(screen.queryByText(/Bruno Díaz/)).toBeNull();
    const snapshot = store.getSnapshot();
    expect(snapshot.phase).toBe("anonymous");
    expect(dataOf(snapshot.client)).toHaveLength(0);
  });
});

describe("onboarding gate (AC-10)", () => {
  it("shows only the password change while a temporary password is pending", async () => {
    let pending = true;
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: { ...ada, mustChangePassword: pending },
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/auth/change-password": () => {
        pending = false;
        return new Response(null, { status: 204 });
      },
    });
    renderApp();
    await screen.findByRole("heading", {
      name: "Cambia tu contraseña temporal",
    });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("link", { name: "Facturas" })).toBeNull();
    expect(transport.calls("GET /api/v1/groups")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
      target: { value: temporary },
    });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
      target: { value: replacement },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect(await screen.findByRole("link", { name: "Facturas" })).toBeTruthy();
    expect(screen.queryByLabelText("Contraseña temporal")).toBeNull();
    expect(transport.unexpected).toEqual([]);
  });

  it("returns to the forced screen when a protected read answers ONBOARDING_REQUIRED", async () => {
    let pending = false;
    const admin = profileFixture({
      memberships: [membership(org, "ADMIN")],
    });
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: { ...admin, mustChangePassword: pending } }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () => {
          pending = true;
          return errorResponse(403, "ONBOARDING_REQUIRED");
        },
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => errorResponse(403, "ONBOARDING_REQUIRED"),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("heading", {
      name: "Cambia tu contraseña temporal",
    });
    // The forced screen replaces whatever URL was open.
    expect(window.location.pathname).toBe("/change-password");
  });
});

describe("401 handling", () => {
  it("returns to login and clears the partition when an org-scoped read answers 401", async () => {
    let expired = false;
    const admin = profileFixture({ memberships: [membership(org, "ADMIN")] });
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        expired
          ? errorResponse(401, "UNAUTHENTICATED")
          : jsonResponse({ profile: admin }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations": () => jsonResponse(organizationsPage([])),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () => {
          expired = true;
          return errorResponse(401, "UNAUTHENTICATED");
        },
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => errorResponse(401, "UNAUTHENTICATED"),
    });
    const { store } = renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.queryByText(/Ada Lovelace/)).toBeNull();
    expect(store.getSnapshot().phase).toBe("anonymous");
    expect(dataOf(store.getSnapshot().client)).toHaveLength(0);
  });
});

describe("secrets never stay in the QueryClient (AC-10)", () => {
  it("keeps the rejected login password out of both caches", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => errorResponse(401, "UNAUTHENTICATED"),
      "POST /api/v1/auth/login": () => errorResponse(401, "UNAUTHENTICATED"),
    });
    const { store } = renderApp();
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fillLogin("123456785", "wrong-password-xyz");
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Iniciar sesión" }),
      ).toHaveProperty("disabled", false),
    );
    const dump = serializeClient(store.getSnapshot().client);
    expect(dump).not.toContain("wrong-password-xyz");
  });

  it("keeps the passwords of a rejected password change out of both caches", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: { ...ada, mustChangePassword: true } }),
      "POST /api/v1/auth/change-password": () =>
        errorResponse(400, "PASSWORD_REUSE"),
    });
    const { store } = renderApp();
    await screen.findByLabelText("Contraseña temporal");
    fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
      target: { value: temporary },
    });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
      target: { value: replacement },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    await screen.findByText(
      "La nueva contraseña debe ser distinta de la actual.",
    );
    const dump = serializeClient(store.getSnapshot().client);
    expect(dump).not.toContain(temporary);
    expect(dump).not.toContain(replacement);
    expect(store.getSnapshot().client.getMutationCache().getAll()).toHaveLength(
      0,
    );
  });
});

describe("StrictMode does not duplicate writes", () => {
  it("sends one login and one password change per submit", async () => {
    let signedIn = false;
    let pending = true;
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        signedIn
          ? jsonResponse({ profile: { ...ada, mustChangePassword: pending } })
          : errorResponse(401, "UNAUTHENTICATED"),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "POST /api/v1/auth/login": () => {
        signedIn = true;
        return jsonResponse({ user: {} });
      },
      "POST /api/v1/auth/change-password": () => {
        pending = false;
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ strict: true });
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fillLogin("123456785", temporary);
    await screen.findByLabelText("Contraseña temporal");
    fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
      target: { value: temporary },
    });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
      target: { value: replacement },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    await screen.findByRole("link", { name: "Facturas" });
    expect(transport.calls("POST /api/v1/auth/login")).toHaveLength(1);
    expect(transport.calls("POST /api/v1/auth/change-password")).toHaveLength(
      1,
    );
  });
});
