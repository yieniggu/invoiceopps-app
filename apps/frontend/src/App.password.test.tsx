import { ACCESS_NONE } from "./test/transport";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { openPolicies } from "./test/policiesRoute";

// Políticas is disabled in the product; the screen is kept unrouted. Its
// ONBOARDING_REQUIRED and logout races keep running through the test route.
vi.mock("./features/session/AppRoutes", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./features/session/AppRoutes")>();
  const { withPoliciesRoute } = await import("./test/policiesRoute");
  return { ...original, AppRoutes: withPoliciesRoute(original.AppRoutes) };
});

const temporary = "temporary-password-1";
const profile = {
  id: "user-1",
  name: "Ada Lovelace",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  memberships: [
    {
      organization: { id: "organization-1", name: "AI Academy", slug: "ai" },
      role: "USER",
      ...ACCESS_NONE,
    },
  ],
};
const pending = { ...profile, mustChangePassword: true };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Handler = () => Promise<Response> | Response;

function mockPending(changePassword: Handler) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/profile")
        return jsonResponse({ profile: pending });
      if (url === "/api/v1/auth/change-password" && init?.method === "POST")
        return changePassword();
      if (url === "/api/v1/groups") return jsonResponse({ groups: [] });
      throw new Error(`Unexpected fetch request: ${url}`);
    });
}

async function renderForcedScreen() {
  render(<App />);
  await screen.findByRole("heading", {
    name: /cambia tu contraseña temporal/i,
  });
}

function fill(current: string, next: string) {
  fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
    target: { value: next },
  });
}

const submit = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /cambiar contraseña|cambiando/i }),
  );

const passwordPosts = (fetchMock: ReturnType<typeof mockPending>) =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === "/api/v1/auth/change-password" &&
      init?.method === "POST",
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CR-021 temporary password submit", () => {
  it("sends one request for a double submit and shows a pending state", async () => {
    let finish: (response: Response) => void = () => {};
    const fetchMock = mockPending(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await renderForcedScreen();
    fill(temporary, "a-new-password-123");

    submit();
    submit();
    fireEvent.submit(
      screen.getByLabelText("Contraseña nueva").closest("form")!,
    );

    const button = await screen.findByRole("button", { name: /cambiando/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(passwordPosts(fetchMock)).toHaveLength(1);

    finish(new Response(null, { status: 204 }));
    await waitFor(() => expect(passwordPosts(fetchMock)).toHaveLength(1));
  });

  it("shows a Spanish network error and re-enables the form", async () => {
    mockPending(() => {
      throw new TypeError("Failed to fetch");
    });
    await renderForcedScreen();
    fill(temporary, "a-new-password-123");

    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /No fue posible conectar con el servidor/,
    );
    const button = screen.getByRole("button", { name: "Cambiar contraseña" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows a second attempt after a failure", async () => {
    let calls = 0;
    const fetchMock = mockPending(() => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 204 });
    });
    await renderForcedScreen();
    fill(temporary, "a-new-password-123");

    submit();
    await screen.findByRole("alert");
    submit();

    await waitFor(() => expect(passwordPosts(fetchMock)).toHaveLength(2));
  });
});

describe("CR-022 temporary password accessibility", () => {
  it("validates the length itself: Spanish message, focus, aria-invalid, no request", async () => {
    const fetchMock = mockPending(() => new Response(null, { status: 204 }));
    await renderForcedScreen();
    fill(temporary, "1234567");

    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "La contraseña nueva debe tener entre 8 y 256 caracteres.",
    );
    const field = screen.getByLabelText("Contraseña nueva");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(
      screen.getByLabelText("Contraseña temporal").getAttribute("aria-invalid"),
    ).toBe("false");
    expect(passwordPosts(fetchMock)).toHaveLength(0);
  });

  it("asks for the temporary password when it is empty and focuses that field", async () => {
    mockPending(() => new Response(null, { status: 204 }));
    await renderForcedScreen();
    fill("", "a-new-password-123");

    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Ingresa tu contraseña temporal.");
    const field = screen.getByLabelText("Contraseña temporal");
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("focuses the new password and links the error on PASSWORD_REUSE", async () => {
    mockPending(() =>
      jsonResponse(
        {
          error: {
            code: "PASSWORD_REUSE",
            message: "The new password must differ from the current one.",
          },
        },
        400,
      ),
    );
    await renderForcedScreen();
    fill(temporary, temporary);

    submit();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "La nueva contraseña debe ser distinta de la actual.",
    );
    const field = screen.getByLabelText("Contraseña nueva");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("focuses the new password on a server validation error", async () => {
    mockPending(() =>
      jsonResponse(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid password change",
            fields: { newPassword: "Too big" },
          },
        },
        400,
      ),
    );
    await renderForcedScreen();
    fill(temporary, "a-new-password-123");

    submit();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /entre 8 y 256/,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByLabelText("Contraseña nueva"),
      ),
    );
  });

  it("does not mark a field invalid for an error that belongs to none", async () => {
    mockPending(() => jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500));
    await renderForcedScreen();
    fill(temporary, "a-new-password-123");

    submit();

    await screen.findByRole("alert");
    for (const label of ["Contraseña temporal", "Contraseña nueva"]) {
      expect(screen.getByLabelText(label).getAttribute("aria-invalid")).toBe(
        "false",
      );
    }
  });
});

describe("CR-020 mid-session ONBOARDING_REQUIRED", () => {
  it("reloads the profile and shows the forced screen instead of a generic error", async () => {
    let profileReads = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url === "/api/v1/auth/profile") {
          profileReads += 1;
          return jsonResponse({
            profile: profileReads === 1 ? profile : pending,
          });
        }
        if (url === "/api/v1/groups") {
          return jsonResponse(
            {
              error: {
                code: "ONBOARDING_REQUIRED",
                message: "Password change required",
              },
            },
            403,
          );
        }
        throw new Error(`Unexpected fetch request: ${url}`);
      });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: /cambia tu contraseña temporal/i,
      }),
    ).toBeTruthy();
    expect(profileReads).toBe(2);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/v1/groups",
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(/No fue posible cargar el contexto/)).toBeNull();
  });

  it("does not reload for a plain 403", async () => {
    let profileReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/auth/profile") {
        profileReads += 1;
        return jsonResponse({ profile });
      }
      if (url === "/api/v1/groups") {
        return jsonResponse(
          { error: { code: "FORBIDDEN", message: "No" } },
          403,
        );
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0),
    );
    expect(profileReads).toBe(1);
  });

  it("does not loop when the profile still says no password change is pending", async () => {
    let profileReads = 0;
    let groupReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/v1/auth/profile") {
        profileReads += 1;
        return jsonResponse({ profile });
      }
      if (url === "/api/v1/groups") {
        groupReads += 1;
        return jsonResponse(
          {
            error: {
              code: "ONBOARDING_REQUIRED",
              message: "Password change required",
            },
          },
          403,
        );
      }
      throw new Error(`Unexpected fetch request: ${url}`);
    });

    render(<App />);

    await waitFor(() => expect(profileReads).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(profileReads).toBe(2);
    // The profile refresh does not re-request the workspace catalogue (its own
    // Query key); the single failed read stays visible as a retryable error.
    expect(groupReads).toBe(1);
    expect(
      screen.queryByRole("heading", { name: /cambia tu contraseña temporal/i }),
    ).toBeNull();
  });
});

describe("CR-020 ONBOARDING_REQUIRED from screens", () => {
  const sessionProfile = {
    ...profile,
    mustChangePassword: false,
    memberships: [
      {
        organization: { id: "org", name: "Academia", slug: "academy" },
        role: "USER",
        ...ACCESS_NONE,
      },
    ],
  };
  const groups = [
    {
      id: "group",
      name: "Equipo",
      organization: { id: "org", name: "Academia" },
      members: [],
    },
  ];
  const onboarding = () =>
    jsonResponse(
      {
        error: {
          code: "ONBOARDING_REQUIRED",
          message: "Password change required",
        },
      },
      403,
    );

  function mockSession(options: {
    policies: () => Promise<Response> | Response;
    logout?: () => Promise<Response> | Response;
    onProfileRead?: () => void;
    isPending: () => boolean;
  }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input), "http://test.invalid");
      if (url.pathname === "/api/v1/auth/profile") {
        options.onProfileRead?.();
        return jsonResponse({
          profile: options.isPending()
            ? { ...sessionProfile, mustChangePassword: true }
            : sessionProfile,
        });
      }
      if (url.pathname === "/api/v1/groups") return jsonResponse({ groups });
      if (url.pathname === "/api/v1/auth/logout")
        return options.logout?.() ?? new Response(null, { status: 204 });
      if (url.pathname.startsWith("/api/v1/business-policies"))
        return options.policies();
      throw new Error(`Unexpected fetch request: ${url.pathname}`);
    });
  }

  it("shows the forced screen when a policies read answers ONBOARDING_REQUIRED", async () => {
    let pending = false;
    mockSession({
      isPending: () => pending,
      policies: () => {
        pending = true;
        return onboarding();
      },
    });
    render(<App />);

    await screen.findByRole("heading", { name: "Panel principal" });
    await openPolicies();

    expect(
      await screen.findByRole("heading", {
        name: /cambia tu contraseña temporal/i,
      }),
    ).toBeTruthy();
  });

  it("shows the forced screen when an invoices read answers ONBOARDING_REQUIRED", async () => {
    let pending = false;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input), "http://test.invalid");
        if (url.pathname === "/api/v1/auth/profile")
          return jsonResponse({
            profile: pending
              ? { ...sessionProfile, mustChangePassword: true }
              : sessionProfile,
          });
        if (url.pathname === "/api/v1/groups") return jsonResponse({ groups });
        if (url.pathname.startsWith("/api/v1/invoices")) {
          pending = true;
          return onboarding();
        }
        throw new Error(`Unexpected fetch request: ${url.pathname}`);
      });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: /^Facturas$/ }));

    expect(
      await screen.findByRole("heading", {
        name: /cambia tu contraseña temporal/i,
      }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/v1/invoices"),
      ),
    ).toBe(true);
  });

  it("ignores ONBOARDING_REQUIRED that arrives after logout started", async () => {
    let profileReads = 0;
    let finishPolicies: (response: Response) => void = () => {};
    let finishLogout: (response: Response) => void = () => {};
    let logoutRequested = false;
    mockSession({
      isPending: () => true,
      onProfileRead: () => void (profileReads += 1),
      policies: () =>
        new Promise<Response>((resolve) => {
          finishPolicies = resolve;
        }),
      logout: () =>
        new Promise<Response>((resolve) => {
          logoutRequested = true;
          finishLogout = resolve;
        }),
    });
    // The first profile read must be the normal one.
    let first = true;
    const fetchSpy = vi.mocked(globalThis.fetch);
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/profile" && first) {
        first = false;
        profileReads += 1;
        return jsonResponse({ profile: sessionProfile });
      }
      return original(input, init);
    });
    render(<App />);

    await screen.findByRole("heading", { name: "Panel principal" });
    await openPolicies();
    fireEvent.click(screen.getByRole("button", { name: /salir/i }));
    // The logout request is issued once the mutation has cancelled the
    // identity's in-flight reads.
    await waitFor(() => expect(logoutRequested).toBe(true));
    // The policies screen reads the profile itself; only reads after the
    // logout started would be a reload.
    const readsAtLogout = profileReads;
    await act(async () => {
      finishPolicies(onboarding());
      finishLogout(new Response(null, { status: 204 }));
    });

    expect(
      await screen.findByRole("button", { name: /iniciar sesión|ingresar/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /cambia tu contraseña temporal/i }),
    ).toBeNull();
    expect(profileReads).toBe(readsAtLogout);
  });
});
