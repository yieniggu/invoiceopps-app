import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthScreen } from "./AuthScreen";

const password = "test-password-123";

function fillForm(signup = false) {
  if (signup) {
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre" }), {
      target: { value: "Ada Lovelace" },
    });
  }
  fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
    target: { value: "123456785" },
  });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: password },
  });
}

function deferredResponse() {
  let complete: (response: Response) => void = () => {
    throw new Error("Deferred response not initialized");
  };
  const response = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  return { response, complete };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthScreen recovery and lifecycle", () => {
  it.each([
    {
      signup: true,
      status: 403,
      feedback: /registro no está autorizado.*administración/i,
    },
    { signup: false, status: 403, feedback: /recarga.*intenta nuevamente/i },
    { signup: true, status: 429, feedback: /demasiados intentos.*espera/i },
    { signup: false, status: 429, feedback: /demasiados intentos.*espera/i },
    { signup: true, status: 500, feedback: /registro.*nuevamente/i },
    { signup: false, status: 503, feedback: /iniciar sesión.*nuevamente/i },
  ])(
    "handles HTTP $status safely (signup=$signup)",
    async ({ signup, status, feedback }) => {
      const rawMessage = "Internal provider details must stay private";
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(
            JSON.stringify({ status: "error", message: rawMessage }),
            { status },
          ),
        );
      const onLogin = vi.fn();
      render(<AuthScreen onLogin={onLogin} />);
      if (signup)
        fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
      fillForm(signup);
      fireEvent.click(
        screen.getByRole("button", {
          name: signup ? "Crear cuenta" : "Iniciar sesión",
        }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(feedback);
      expect(alert.textContent).not.toContain(rawMessage);
      expect(alert.textContent).not.toContain(password);
      expect(screen.getByLabelText("Contraseña")).toHaveProperty("value", "");
      expect(screen.getByRole("textbox", { name: "RUT" })).toHaveProperty(
        "value",
        "123456785",
      );
      if (signup)
        expect(screen.getByRole("textbox", { name: "Nombre" })).toHaveProperty(
          "value",
          "Ada Lovelace",
        );
      expect(
        screen.getByRole("button", {
          name: signup ? "Crear cuenta" : "Iniciar sesión",
        }),
      ).toHaveProperty("disabled", false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onLogin).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "recovers from rejected fetch without automatic retry (signup=%s)",
    async (signup) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("Private network diagnostic"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              user: { id: "user-1", name: "Ada Lovelace", rut: "123456785" },
            }),
            { status: signup ? 201 : 200 },
          ),
        );
      const onLogin = vi.fn();
      render(<AuthScreen onLogin={onLogin} />);
      if (signup)
        fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
      fillForm(signup);
      fireEvent.click(
        screen.getByRole("button", {
          name: signup ? "Crear cuenta" : "Iniciar sesión",
        }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/conexión.*intenta nuevamente/i);
      expect(alert.textContent).not.toContain("Private network diagnostic");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onLogin).not.toHaveBeenCalled();
      fillForm(signup);
      fireEvent.click(
        screen.getByRole("button", {
          name: signup ? "Crear cuenta" : "Iniciar sesión",
        }),
      );
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      if (signup) {
        expect((await screen.findByRole("status")).textContent).toMatch(
          /cuenta creada/i,
        );
        expect(onLogin).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
      }
      expect(screen.getByLabelText("Contraseña")).toHaveProperty("value", "");
    },
  );

  it("prevents duplicate signup submissions while pending and clears the password on success", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(deferred.response);
    const onLogin = vi.fn();
    try {
      render(<AuthScreen onLogin={onLogin} />);
      fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
      fillForm(true);
      const submit = screen.getByRole("button", { name: "Crear cuenta" });
      fireEvent.click(submit);
      expect(submit).toHaveProperty("disabled", true);
      expect(screen.getByRole("status").textContent).toMatch(/creando cuenta/i);
      fireEvent.click(submit);
      fireEvent.submit(screen.getByRole("form", { name: "Crear cuenta" }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () =>
        deferred.complete(
          new Response(
            JSON.stringify({
              user: { id: "user-1", name: "Ada Lovelace", rut: "123456785" },
            }),
            { status: 201 },
          ),
        ),
      );
      expect(screen.getByRole("status").textContent).toMatch(/cuenta creada/i);
      expect(screen.getByLabelText("Contraseña")).toHaveProperty("value", "");
      expect(onLogin).not.toHaveBeenCalled();
    } finally {
      await act(async () =>
        deferred.complete(new Response(null, { status: 503 })),
      );
    }
  });

  it("aborts a pending login when switching mode and ignores its late success", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(deferred.response);
    const onLogin = vi.fn();
    try {
      render(<AuthScreen onLogin={onLogin} />);
      fillForm();
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
      const signal = fetchMock.mock.calls[0][1]?.signal;
      expect(signal?.aborted).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Crear cuenta" }));
      expect(signal?.aborted).toBe(true);
      expect(screen.getByLabelText("Contraseña")).toHaveProperty("value", "");
      await act(async () =>
        deferred.complete(new Response(null, { status: 200 })),
      );
      expect(onLogin).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", { name: "Crear cuenta" }),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      await act(async () =>
        deferred.complete(new Response(null, { status: 503 })),
      );
    }
  });

  it("aborts on unmount and never announces a late login success", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValue(deferred.response);
    const onLogin = vi.fn();
    try {
      const { unmount } = render(<AuthScreen onLogin={onLogin} />);
      fillForm();
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
      const signal = fetchMock.mock.calls[0][1]?.signal;
      unmount();
      expect(signal?.aborted).toBe(true);
      await act(async () =>
        deferred.complete(new Response(null, { status: 200 })),
      );
      expect(onLogin).not.toHaveBeenCalled();
    } finally {
      await act(async () =>
        deferred.complete(new Response(null, { status: 503 })),
      );
    }
  });

  it("reports missing fields without making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /completa los datos/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
