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
      "/auth/login",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("signup")),
    ).toBe(false);
  });
});
