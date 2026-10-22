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

// Keep the external resource feature isolated, as in the existing App suite.
vi.mock("./features/resources/MlflowResources", () => ({
  MlflowResources: () => null,
}));

const user = { id: "user-1", name: "Ada Lovelace", rut: "123456785" };
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
      role: "STUDENT",
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
      if (url === "/profile" && (!init?.method || init.method === "GET")) {
        return authenticated
          ? authenticatedProfile()
          : jsonResponse({ status: "error", message: "Unauthorized" }, 401);
      }
      if (url === "/auth/login" && init?.method === "POST") {
        return login();
      }
      if (url === "/auth/signup" && init?.method === "POST") {
        return signup();
      }
      if (url === "/groups") {
        return jsonResponse({ groups: [] });
      }
      if (url.startsWith("/resources?")) {
        return jsonResponse({ resources: [] });
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

async function openSignup() {
  fireEvent.click(await screen.findByRole("button", { name: signupName }));
  fireEvent.change(screen.getByRole("textbox", { name: /nombre/i }), {
    target: { value: user.name },
  });
  fillCredentials();
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
      return /^\/(?:groups|resources|invoices|mlflow\/resources|platform\/organizations|organizations)(?:[/?]|$)/.test(
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
      expect(screen.getByText(/estudiante/i)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: /cerrar sesión/i }),
      ).toBeTruthy();
      expectJsonPost(fetchMock, "/auth/login", { rut: user.rut, password });
      expect(fetchMock).toHaveBeenCalledWith("/profile", {
        credentials: "same-origin",
      });
      expect(storageWrite).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        completeProfile?.(jsonResponse({ profile }));
      });
    }
  });

  it("registers with the existing payload and confirms registration without creating a session", async () => {
    const { fetchMock, login, authenticatedProfile } = mockAuthHttp();
    render(<App />);
    await openSignup();
    fireEvent.click(screen.getByRole("button", { name: signupName }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(
        /(?:cuenta|registro).*(?:cread|exitos|complet)|registrad/i,
      );
    });
    expect(screen.getByRole("button", { name: loginName })).toBeTruthy();
    expectJsonPost(fetchMock, "/auth/signup", {
      name: user.name,
      rut: user.rut,
      password,
    });
    expect(login).not.toHaveBeenCalled();
    expect(authenticatedProfile).not.toHaveBeenCalled();
    expectNoProtectedResourceRequests(fetchMock);
    expect(screen.queryByRole("button", { name: /cerrar sesión/i })).toBeNull();
    expect(screen.queryByText(profile.name)).toBeNull();
  });

  it("announces rejected credentials safely in Spanish and allows another login attempt", async () => {
    const { login, authenticatedProfile } = mockAuthHttp();
    login.mockResolvedValueOnce(
      jsonResponse({ status: "error", message: "Invalid credentials" }, 401),
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
        jsonResponse({ status: "error", message: "Invalid credentials" }, 401),
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
            { status: "error", message: "Invalid credentials" },
            401,
          ),
        );
      });
    }
  });

  it("explains the minimum signup password length before sending a request", async () => {
    const { signup } = mockAuthHttp();
    render(<App />);
    await openSignup();
    fillCredentials("too-short");
    fireEvent.click(screen.getByRole("button", { name: signupName }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /(?:contraseña.*12|12.*caracteres)/i,
    );
    expect(signup).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: signupName })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it.each([
    { status: 400, message: "Invalid signup request" },
    { status: 409, message: "Account cannot be created" },
  ])(
    "recovers from signup HTTP $status without exposing the API message",
    async ({ status, message }) => {
      const { signup, authenticatedProfile } = mockAuthHttp();
      signup.mockResolvedValueOnce(
        jsonResponse({ status: "error", message }, status),
      );
      render(<App />);
      await openSignup();
      fireEvent.click(screen.getByRole("button", { name: signupName }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/cuenta|registro|registr|datos/i);
      expect(alert.textContent).not.toContain(message);
      expect(alert.textContent).not.toContain(password);
      expect(authenticatedProfile).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: signupName })).toHaveProperty(
        "disabled",
        false,
      );
      expect(screen.getByRole("textbox", { name: /nombre/i })).toHaveProperty(
        "value",
        user.name,
      );
      fillCredentials();
      fireEvent.click(screen.getByRole("button", { name: signupName }));
      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toMatch(
          /(?:cuenta|registro).*(?:cread|exitos|complet)|registrad/i,
        );
      });
      expect(signup).toHaveBeenCalledTimes(2);
      expect(authenticatedProfile).not.toHaveBeenCalled();
    },
  );
});
