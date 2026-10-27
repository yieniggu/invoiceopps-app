import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    render(<AuthScreen onLogin={onLogin} />);
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
    render(<AuthScreen onLogin={onLogin} />);
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
    render(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const error = screen.getByText("RUT inválido");
    expect(rutInput.getAttribute("aria-invalid")).toBe("true");
    expect(rutInput.getAttribute("aria-describedby")).toBe(error.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the field error and focuses the RUT when the password is empty", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const fieldError = screen.getByText("RUT inválido");
    expect(fieldError.getAttribute("role")).toBe("alert");
    expect(rutInput.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(rutInput);
    expect(
      screen.getByText("Completa los datos requeridos para continuar."),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses the first invalid field and announces the RUT error after submit", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", { name: "RUT" });
    fireEvent.change(rutInput, { target: { value: "190347908" } });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "temporary-password" },
    });
    expect(screen.queryByText("RUT inválido")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(screen.getByRole("alert").textContent).toBe("RUT inválido");
    expect(document.activeElement).toBe(rutInput);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("focuses the password when only the password is missing", () => {
    render(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Contraseña"));
  });

  it("does not silently keep a leading-zero RUT", () => {
    render(<AuthScreen onLogin={vi.fn()} />);
    const rutInput = screen.getByRole("textbox", {
      name: "RUT",
    }) as HTMLInputElement;
    fireEvent.change(rutInput, { target: { value: "0" } });
    expect(rutInput.value).toBe("");
    fireEvent.change(rutInput, { target: { value: "012345674" } });
    expect(rutInput.value).toBe("1.234.567-4");
  });
});
