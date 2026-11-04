import { focusManager } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatInstant } from "./lib/datetime";

import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const me = profileFixture({
  memberships: [
    membership(
      { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
      "USER",
    ),
  ],
});

const routes = (
  user: Record<string, unknown>,
  shared = [
    { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
  ],
) => ({
  "GET /api/v1/auth/profile": () => jsonResponse({ profile: me }),
  "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
  "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
    jsonResponse({
      user: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Carla Soto",
        email: null,
        recentlyActive: false,
        lastActiveAt: null,
        ...user,
      },
      sharedOrganizations: shared,
    }),
});

describe("basic user profile at /users/:userId (AC-17)", () => {
  it("shows name, email, activity and the shared organizations as links to any authenticated user", async () => {
    mockTransport(
      routes({
        email: "carla@example.test",
        recentlyActive: false,
        lastActiveAt: new Date(
          Date.now() - 2.5 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
    );
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const data = screen.getByRole("region", { name: "Datos" });
    expect(data.textContent).toContain("Correocarla@example.test");
    expect(data.textContent).toContain("ActividadActivo hace 2 d");
    expect(
      screen.getByRole("link", { name: "Academia Norte" }).getAttribute("href"),
    ).toBe("/organizations/00000000-0000-4000-9000-000000000001");
    // No administrative data or action on this screen.
    expect(screen.queryByText("RUT")).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
  });

  it("says «Sin correo» and «Nunca» when there is no email and no activity ever", async () => {
    mockTransport(routes({}));
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const data = screen.getByRole("region", { name: "Datos" });
    expect(data.textContent).toContain("CorreoSin correo");
    expect(data.textContent).toContain("ActividadNunca");
  });

  it("answers 404 with the not-found screen", async () => {
    mockTransport({
      ...routes({}),
      "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
        errorResponse(404, "NOT_FOUND"),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", {
      level: 1,
      name: "Página no encontrada",
    });
  });

  it("offers a retry when the read fails", async () => {
    let calls = 0;
    mockTransport({
      ...routes({}),
      "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () => {
        calls += 1;
        return calls === 1
          ? errorResponse(500, "INTERNAL_ERROR")
          : jsonResponse({
              user: {
                id: "00000000-0000-4000-8000-000000000003",
                name: "Carla Soto",
                email: null,
                recentlyActive: false,
                lastActiveAt: null,
              },
              sharedOrganizations: [],
            });
      },
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Reintentar persona" }),
    );
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByText("No compartes organizaciones con esta persona."),
    ).toBeTruthy();
  });

  it("is reached from the reduced member list", async () => {
    mockTransport({
      ...routes({}),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members":
        () =>
          jsonResponse({
            members: [
              {
                userId: "00000000-0000-4000-8000-000000000003",
                name: "Carla Soto",
                email: null,
                recentlyActive: false,
                lastActiveAt: null,
              },
            ],
            page: 1,
            pageSize: 20,
            total: 1,
          }),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    fireEvent.click(await screen.findByRole("link", { name: "Carla Soto" }));
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(window.location.pathname).toBe(
      "/users/00000000-0000-4000-8000-000000000003",
    );
  });
});

describe("platform administrator on /users/:userId (CR-290)", () => {
  const platform = profileFixture({
    id: "00000000-0000-4000-b000-000000000001",
    isPlatformAdministrator: true,
  });
  const asPlatform = (overrides: Record<string, unknown> = {}) => ({
    ...routes({}, []),
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    ...overrides,
  });

  it("speaks of the person's organizations, never of shared ones", async () => {
    mockTransport(asPlatform());
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByRole("heading", { level: 2, name: "Organizaciones" }),
    ).toBeTruthy();
    expect(
      screen.getByText("Esta persona no pertenece a ninguna organización."),
    ).toBeTruthy();
    expect(screen.queryByText(/compart/i)).toBeNull();
  });

  it("lists every organization of the person as links", async () => {
    mockTransport({
      ...asPlatform(),
      ...routes({}, [
        { id: "00000000-0000-4000-9000-000000000001", name: "Academia Norte" },
        { id: "00000000-0000-4000-9000-000000000002", name: "Instituto Sur" },
      ]),
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("link", { name: "Instituto Sur" });
    expect(screen.getByRole("link", { name: "Academia Norte" })).toBeTruthy();
    expect(screen.queryByText(/compart/i)).toBeNull();
  });

  it("says the person is not on the platform, not that nothing is shared, on 404", async () => {
    mockTransport(
      asPlatform({
        "GET /api/v1/users/00000000-0000-4000-8000-000000000003": () =>
          errorResponse(404, "NOT_FOUND"),
      }),
    );
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByText("No encontramos a esa persona en la plataforma.");
    expect(screen.queryByText(/comparten organización/)).toBeNull();
  });

  it("keeps the shared-organization copy for everyone else", async () => {
    mockTransport(routes({}, []));
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "Organizaciones compartidas",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("No compartes organizaciones con esta persona."),
    ).toBeTruthy();
  });
});

describe("activity of the basic profile (last-active indicator)", () => {
  const USER = "/api/v1/users/00000000-0000-4000-8000-000000000003";
  const LAST_ACTIVE = "2026-11-04T09:00:00.000Z";

  /** The profile answer, stamped with the server clock `serverDate`. */
  const answer = (serverDate: string, lastActiveAt = LAST_ACTIVE) =>
    new Response(
      JSON.stringify({
        user: {
          id: "00000000-0000-4000-8000-000000000003",
          name: "Carla Soto",
          email: null,
          recentlyActive: false,
          lastActiveAt,
        },
        sharedOrganizations: [],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", Date: serverDate },
      },
    );

  const activity = () =>
    (
      screen
        .getByRole("region", { name: "Datos" })
        .querySelector(".activity-indicator") as HTMLElement
    ).textContent;

  it("measures the age against the server clock and shows the exact instant", async () => {
    mockTransport({
      ...routes({}),
      [`GET ${USER}`]: () => answer("Wed, 04 Nov 2026 12:00:00 GMT"),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    // Three server hours, whatever the clock of this device says.
    expect(activity()).toBe(`Activo hace 3 h (${formatInstant(LAST_ACTIVE)})`);
    const indicator = screen
      .getByRole("region", { name: "Datos" })
      .querySelector(".activity-indicator");
    expect(indicator?.classList.contains("is-day")).toBe(true);
    // The exact instant is visible text on the profile, not only a tooltip.
    expect(screen.getByText(`(${formatInstant(LAST_ACTIVE)})`).className).toBe(
      "activity-instant",
    );
  });

  const refocus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

  it("recomputes the label and the color when the profile refetches on focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let serverDate = "Wed, 04 Nov 2026 12:00:00 GMT";
    const transport = mockTransport({
      ...routes({}),
      [`GET ${USER}`]: () => answer(serverDate),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(activity()).toContain("Activo hace 3 h");

    // Data older than a minute (and younger than the 5-minute interval).
    serverDate = "Wed, 11 Nov 2026 12:00:00 GMT";
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    refocus();
    await waitFor(() => expect(activity()).toContain("Activo hace 7 d"));
    expect(transport.calls(`GET ${USER}`)).toHaveLength(2);
    expect(
      screen
        .getByRole("region", { name: "Datos" })
        .querySelector(".activity-indicator")
        ?.classList.contains("is-stale"),
    ).toBe(true);
  });

  it("does not refetch on focus while the data is less than a minute old", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const transport = mockTransport({
      ...routes({}),
      [`GET ${USER}`]: () => answer("Wed, 04 Nov 2026 12:00:00 GMT"),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    refocus();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(transport.calls(`GET ${USER}`)).toHaveLength(1);
    expect(activity()).toContain("Activo hace 3 h");
  });

  it("refetches every five minutes while the profile stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let serverDate = "Wed, 04 Nov 2026 12:00:00 GMT";
    const transport = mockTransport({
      ...routes({}),
      [`GET ${USER}`]: () => answer(serverDate),
    });
    renderApp({ route: "/users/00000000-0000-4000-8000-000000000003" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(activity()).toContain("Activo hace 3 h");

    serverDate = "Wed, 05 Nov 2026 12:00:00 GMT";
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    await waitFor(() => expect(activity()).toContain("Activo hace 1 d"));
    expect(transport.calls(`GET ${USER}`).length).toBeGreaterThanOrEqual(2);
  });
});
