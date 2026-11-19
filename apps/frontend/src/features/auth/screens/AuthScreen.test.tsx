import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithClient } from "../../../test/renderWithClient";
import { AuthScreen } from "./AuthScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthScreen closed access", () => {
  it("offers login only and never sends a signup request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ user: {} }), { status: 200 }),
      );
    const onLogin = vi.fn();
    renderWithClient(<AuthScreen onLogin={onLogin} />);
    expect(screen.queryByRole("button", { name: /crear cuenta/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /nombre/i })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("signup")),
    ).toBe(false);
  });

  it("auto-formats the RUT while typing and submits the API form", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ user: {} }), { status: 200 }),
      );
    const onLogin = vi.fn();
    renderWithClient(<AuthScreen onLogin={onLogin} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347907" } });
    expect((rutInput as HTMLInputElement).value).toBe("19.034.790-7");
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      rut: "19034790-7",
      password: "temporary-password",
    });
  });

  it("blocks submit and reports an accessible error for an invalid RUT", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const error = screen.getByText("RUT inválido");
    expect(rutInput.getAttribute("aria-invalid")).toBe("true");
    // RV-122: the message lives in a persistent polite region, next to the hint.
    expect(rutInput.getAttribute("aria-describedby")).toContain(error.id);
    expect(error.getAttribute("aria-live")).toBe("polite");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the field error and focuses the RUT when the password is empty", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const fieldError = screen.getByText("RUT inválido");
    expect(fieldError.getAttribute("aria-live")).toBe("polite");
    expect(rutInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(rutInput);
    // RV-120: one specific message per field instead of a generic one.
    expect(screen.getByText("Ingresa tu contraseña")).toBeTruthy();
    expect(
      screen.queryByText("Completa los datos requeridos para continuar."),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses the first invalid field and announces the RUT error after submit", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    expect(screen.queryByText("RUT inválido")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(screen.getByText("RUT inválido").getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(document.activeElement).toBe(rutInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses the password when only the password is missing", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Contraseña"));
  });

  it("does not silently keep a leading-zero RUT", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", {
      name: "RUT",
    }) as HTMLInputElement;
    fireEvent.change(rutInput, { target: { value: "0" } });
    expect(rutInput.value).toBe("");
    fireEvent.change(rutInput, { target: { value: "012345674" } });
    expect(rutInput.value).toBe("1.234.567-4");
  });
});

// docs/rpa-selector-contract.md §3 «Login»: stable anchors and readable state.
describe("AuthScreen automation contract", () => {
  const fillAndSubmit = () => {
    fireEvent.change(screen.getByTestId("login-rut"), {
      target: { value: "190347907" },
    });
    fireEvent.change(screen.getByTestId("login-password"), {
      target: { value: "secret-password" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));
  };
  const apiFailure = (status: number, code?: string) =>
    new Response(JSON.stringify({ error: { code, message: "server text" } }), {
      status,
    });

  it("exposes the anchors with the id, test id and name of the contract", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const form = screen.getByTestId("login-form");
    expect(form.id).toBe("login-form");
    expect(form.getAttribute("data-state")).toBe("idle");
    const rut = screen.getByRole("textbox", { name: "RUT" });
    expect(rut).toBe(screen.getByTestId("login-rut"));
    expect(rut.id).toBe("login-rut");
    expect(rut.getAttribute("name")).toBe("rut");
    const password = screen.getByLabelText("Contraseña");
    expect(password).toBe(screen.getByTestId("login-password"));
    expect(password.id).toBe("login-password");
    expect(password.getAttribute("name")).toBe("password");
    const submit = screen.getByRole("button", { name: "Iniciar sesión" });
    expect(submit).toBe(screen.getByTestId("login-submit"));
    expect(submit.id).toBe("login-submit");
  });

  it.each([
    [undefined, "none"],
    ["logout", "logout"],
    ["unauthorized", "expired"],
  ] as const)("marks the screen for endedBy=%s as %s", (endedBy, reason) => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} endedBy={endedBy} />);
    const main = screen.getByRole("main");
    expect(main.getAttribute("data-screen")).toBe("auth");
    expect(main.getAttribute("data-auth-reason")).toBe(reason);
  });

  it("ties each field message to its field", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.click(screen.getByTestId("login-submit"));
    const rutError = screen.getByTestId("login-rut-error");
    expect(rutError.getAttribute("data-field")).toBe("rut");
    expect(rutError.textContent).toBe("Ingresa tu RUT");
    fireEvent.change(screen.getByTestId("login-rut"), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByTestId("login-submit"));
    const passwordError = screen.getByTestId("login-password-error");
    expect(passwordError.getAttribute("data-field")).toBe("password");
    expect(passwordError.textContent).toBe("Ingresa tu contraseña");
    expect(screen.getByTestId("login-form").getAttribute("data-state")).toBe(
      "idle",
    );
  });

  it("reports pending while the request is out, then success", async () => {
    let answer: (response: Response) => void = () => undefined;
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    const onLogin = vi.fn();
    renderWithClient(<AuthScreen onLogin={onLogin} />);
    fillAndSubmit();
    const form = screen.getByTestId("login-form");
    await waitFor(() =>
      expect(form.getAttribute("data-state")).toBe("pending"),
    );
    answer(new Response(JSON.stringify({ user: {} }), { status: 200 }));
    await waitFor(() =>
      expect(form.getAttribute("data-state")).toBe("success"),
    );
    expect(onLogin).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("login-error")).toBeNull();
  });

  it.each([
    [401, "UNAUTHENTICATED", "credentials", "Revisa el RUT y la contraseña"],
    [400, "VALIDATION_ERROR", "credentials", "Revisa el RUT y la contraseña"],
    [403, "FORBIDDEN_ORIGIN", "forbidden", "No fue posible autorizar"],
    [429, "RATE_LIMITED", "rate-limited", "Demasiados intentos"],
    [503, "SERVICE_UNAVAILABLE", "unknown", "No fue posible iniciar sesión"],
  ])("classifies HTTP %i (%s) as %s", async (status, code, kind, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(apiFailure(status, code));
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fillAndSubmit();
    const error = await screen.findByTestId("login-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.getAttribute("data-error-kind")).toBe(kind);
    expect(error.getAttribute("data-error-status")).toBe(String(status));
    expect(error.getAttribute("data-error-code")).toBe(code);
    expect(error.textContent).toContain(message);
    expect(screen.getByTestId("login-form").getAttribute("data-state")).toBe(
      "error",
    );
  });

  it("keeps the code empty when the API sends none", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 502 }),
    );
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fillAndSubmit();
    const error = await screen.findByTestId("login-error");
    expect(error.getAttribute("data-error-kind")).toBe("unknown");
    expect(error.getAttribute("data-error-status")).toBe("502");
    expect(error.getAttribute("data-error-code")).toBe("");
  });

  it("classifies a request without answer as network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fillAndSubmit();
    const error = await screen.findByTestId("login-error");
    expect(error.getAttribute("data-error-kind")).toBe("network");
    expect(error.getAttribute("data-error-status")).toBe("");
    expect(error.getAttribute("data-error-code")).toBe("NETWORK");
    expect(error.textContent).toContain("No fue posible conectar");
  });

  it("classifies a non-network throw as unknown, not network", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new SyntaxError("bad"));
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fillAndSubmit();
    const error = await screen.findByTestId("login-error");
    expect(error.getAttribute("data-error-kind")).toBe("unknown");
    expect(error.getAttribute("data-error-status")).toBe("");
    expect(error.getAttribute("data-error-code")).toBe("UNKNOWN");
    expect(error.textContent).toContain("No fue posible iniciar sesión");
    expect(error.textContent).not.toContain("conectar");
  });
});
