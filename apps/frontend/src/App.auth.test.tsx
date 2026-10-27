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

const user = { id: "user-1", name: "Ada Lovelace", rut: "12345678-5" };
const password = "test-password-123";
const loginName = /iniciar sesión|ingresar/i;
const signupName = /crear cuenta|registrar(?:se|me)?/i;
const profile = {
  ...user,
  name: "Ada Profile",
  email: "ada@example.test",
  username: "ada",
  isPlatformAdministrator: false,
  memberships: [
    {
      organization: {
        id: "organization-1",
        name: "AI Academy",
        slug: "ai-academy",
      },
      role: "USER",
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockAuthHttp() {
  let authenticated = false;
  const login = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => {
      authenticated = true;
      return jsonResponse({ user });
    });
  const signup = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => jsonResponse({ user }, 201));
  const authenticatedProfile = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => jsonResponse({ profile }));
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (
        url === "/api/v1/auth/profile" &&
        (!init?.method || init.method === "GET")
      ) {
        return authenticated
          ? authenticatedProfile()
          : jsonResponse(
              { error: { code: "UNAUTHENTICATED", message: "Unauthorized" } },
              401,
            );
      }
      if (url === "/api/v1/auth/login" && init?.method === "POST") {
        return login();
      }
      if (url === "/api/v1/auth/signup" && init?.method === "POST") {
        return signup();
      }
      if (url === "/api/v1/groups") {
        return jsonResponse({ groups: [] });
      }
      throw new Error(
        `Unexpected fetch request: ${init?.method ?? "GET"} ${url}`,
      );
    });
  return { fetchMock, login, signup, authenticatedProfile };
}

function fillCredentials(value = password) {
  fireEvent.change(screen.getByRole("textbox", { name: /rut/i }), {
    target: { value: user.rut },
  });
  fireEvent.change(screen.getByLabelText(/^contraseña/i), {
    target: { value },
  });
}

function expectJsonPost(
  fetchMock: ReturnType<typeof mockAuthHttp>["fetchMock"],
  path: string,
  body: unknown,
) {
  expect(fetchMock).toHaveBeenCalledWith(
    path,
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify(body),
    }),
  );
  const call = fetchMock.mock.calls.find(([input]) => input === path);
  expect(new Headers(call?.[1]?.headers).get("Content-Type")).toBe(
    "application/json",
  );
}

function expectNoProtectedResourceRequests(
  fetchMock: ReturnType<typeof mockAuthHttp>["fetchMock"],
) {
  expect(
    fetchMock.mock.calls.some(([input]) => {
      const url = input instanceof Request ? input.url : input.toString();
      return /^\/api\/v1\/(?:groups|invoices|platform\/organizations|organizations)(?:[/?]|$)/.test(
        url,
      );
    }),
  ).toBe(false);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 authentication entry (AC02, AC05)", () => {
  it("logs in with JSON credentials and waits for the authoritative profile and memberships", async () => {
    const { fetchMock, login, authenticatedProfile } = mockAuthHttp();
    let completeProfile: ((response: Response) => void) | undefined;
    authenticatedProfile.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        completeProfile = resolve;
      }),
    );
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    try {
      render(<App />);

      const submit = await screen.findByRole("button", { name: loginName });
      fillCredentials();
      fireEvent.click(submit);

      await waitFor(() =>
        expect(authenticatedProfile).toHaveBeenCalledTimes(1),
      );
      expect(screen.queryByText(profile.name)).toBeNull();
      expect(screen.queryByText("AI Academy")).toBeNull();
      expect(login.mock.invocationCallOrder[0]).toBeLessThan(
        authenticatedProfile.mock.invocationCallOrder[0],
      );
      expectNoProtectedResourceRequests(fetchMock);
      if (!completeProfile) {
        throw new Error("Authoritative profile request did not start");
      }
      completeProfile(jsonResponse({ profile }));
      fireEvent.click(await screen.findByRole("button", { name: "Mi perfil" }));
      expect(await screen.findByText(profile.name)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Organizaciones" }));
      expect(await screen.findByText("AI Academy")).toBeTruthy();
      expect(screen.getByText(/usuario/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: /^salir$/i })).toBeTruthy();
      expectJsonPost(fetchMock, "/api/v1/auth/login", {
        rut: user.rut,
        password,
      });
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/profile", {
        credentials: "same-origin",
      });
      expect(storageWrite).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        completeProfile?.(jsonResponse({ profile }));
      });
    }
  });

  it("offers login only and never emits a signup request", async () => {
    const { fetchMock, login, authenticatedProfile } = mockAuthHttp();
    render(<App />);
    expect(await screen.findByRole("button", { name: loginName })).toBeTruthy();
    expect(screen.queryByRole("button", { name: signupName })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /nombre/i })).toBeNull();
    expect(login).not.toHaveBeenCalled();
    expect(authenticatedProfile).not.toHaveBeenCalled();
    expectNoProtectedResourceRequests(fetchMock);
    expect(
      fetchMock.mock.calls.some(([input]) => input === "/api/v1/auth/signup"),
    ).toBe(false);
    expect(screen.queryByRole("button", { name: /^salir$/i })).toBeNull();
    expect(screen.queryByText(profile.name)).toBeNull();
  });

  it("forces the temporary-password screen and submits only the password-change endpoint", async () => {
    const temporaryProfile = { ...profile, mustChangePassword: true };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/auth/profile")
          return jsonResponse({ profile: temporaryProfile });
        if (url === "/api/v1/auth/change-password" && init?.method === "POST")
          return new Response(null, { status: 204 });
        if (url === "/api/v1/groups") return jsonResponse({ groups: [] });
        throw new Error(`Unexpected fetch request: ${url}`);
      });
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: /cambia tu contraseña temporal/i,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
      target: { value: password },
    });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
      target: { value: "changed-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/auth/change-password",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            currentPassword: password,
            newPassword: "changed-password-123",
          }),
        }),
      ),
    );
  });

  it("explains in Spanish that the new password must differ from the temporary one", async () => {
    const temporaryProfile = { ...profile, mustChangePassword: true };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/profile")
        return jsonResponse({ profile: temporaryProfile });
      if (url === "/api/v1/auth/change-password" && init?.method === "POST")
        return jsonResponse(
          {
            error: {
              code: "PASSWORD_REUSE",
              message: "New password must differ from the current one",
            },
          },
          400,
        );
      if (url === "/api/v1/groups") return jsonResponse({ groups: [] });
      throw new Error(`Unexpected fetch request: ${url}`);
    });
    render(<App />);
    await screen.findByRole("heading", {
      name: /cambia tu contraseña temporal/i,
    });
    fireEvent.change(screen.getByLabelText("Contraseña temporal"), {
      target: { value: password },
    });
    fireEvent.change(screen.getByLabelText("Contraseña nueva"), {
      target: { value: password },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cambiar contraseña" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "La nueva contraseña debe ser distinta de la actual.",
    );
  });

  it("announces rejected credentials safely in Spanish and allows another login attempt", async () => {
    const { login, authenticatedProfile } = mockAuthHttp();
    login.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "UNAUTHENTICATED", message: "Invalid credentials" } },
        401,
      ),
    );
    render(<App />);
    const submit = await screen.findByRole("button", { name: loginName });
    fillCredentials();
    fireEvent.click(submit);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/credenciales|rut|contraseña/i);
    expect(alert.textContent).not.toContain("Invalid credentials");
    expect(alert.textContent).not.toContain(password);
    expect(authenticatedProfile).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: loginName })).toHaveProperty(
      "disabled",
      false,
    );
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: loginName }));
    fireEvent.click(await screen.findByRole("button", { name: "Mi perfil" }));
    expect(await screen.findByText(profile.name)).toBeTruthy();
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("announces pending login and prevents duplicate requests until it settles", async () => {
    const { login } = mockAuthHttp();
    let completeLogin: ((response: Response) => void) | undefined;
    login.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        completeLogin = resolve;
      }),
    );
    try {
      render(<App />);
      const submit = await screen.findByRole("button", { name: loginName });
      fillCredentials();
      fireEvent.click(submit);

      await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
      expect(submit).toHaveProperty("disabled", true);
      expect(screen.getByRole("status").textContent).toMatch(
        /iniciando|ingresando|cargando|verificando/i,
      );
      fireEvent.click(submit);
      expect(login).toHaveBeenCalledTimes(1);
      if (!completeLogin) {
        throw new Error("Login request did not start");
      }
      completeLogin(
        jsonResponse(
          {
            error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
          },
          401,
        ),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByRole("button", { name: loginName })).toHaveProperty(
        "disabled",
        false,
      );
    } finally {
      await act(async () => {
        completeLogin?.(
          jsonResponse(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "Invalid credentials",
              },
            },
            401,
          ),
        );
      });
    }
  });

  it("does not expose a signup form or client-side signup validation", async () => {
    const { fetchMock } = mockAuthHttp();
    render(<App />);
    expect(screen.queryByText(/cuenta creada|registro/i)).toBeNull();
    expect(screen.queryByRole("button", { name: signupName })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) => input === "/api/v1/auth/signup"),
    ).toBe(false);
  });

  it("keeps signup failures unreachable from the login surface", async () => {
    const { fetchMock, authenticatedProfile } = mockAuthHttp();
    render(<App />);
    expect(
      screen.queryByText(/Invalid signup request|Account cannot be created/),
    ).toBeNull();
    expect(authenticatedProfile).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([input]) => input === "/api/v1/auth/signup"),
    ).toBe(false);
  });
});
