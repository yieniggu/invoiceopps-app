import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  deferred,
  errorResponse,
  jsonResponse,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CHANGE = "POST /api/v1/auth/change-password";
const CURRENT = "Contraseña actual";
const NEXT = "Contraseña nueva";

function open(reply: () => Response | Promise<Response>) {
  const transport = mockTransport({
    "GET /api/v1/auth/profile": () =>
      jsonResponse({ profile: profileFixture() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [CHANGE]: reply,
  });
  const view = renderApp({ route: "/profile" });
  return { ...view, transport };
}

const section = () =>
  screen.findByRole("region", { name: "Contraseña" }) as Promise<HTMLElement>;

async function fill(current: string, next: string) {
  const region = await section();
  fireEvent.change(within(region).getByLabelText(CURRENT), {
    target: { value: current },
  });
  fireEvent.change(within(region).getByLabelText(NEXT), {
    target: { value: next },
  });
  return region;
}

const submit = (region: HTMLElement) =>
  fireEvent.click(
    within(region).getByRole("button", {
      name: /cambiar contraseña|cambiando/i,
    }),
  );

describe("profile password section", () => {
  it("AC-01 shows the password fields with show/hide and the submit button", async () => {
    open(() => new Response(null, { status: 204 }));
    const region = await section();
    expect(within(region).getByLabelText(CURRENT)).toBeTruthy();
    expect(within(region).getByLabelText(NEXT)).toBeTruthy();
    expect(
      within(region).getAllByRole("button", { name: "Mostrar contraseña" }),
    ).toHaveLength(2);
    expect(
      within(region).getByRole("button", { name: "Cambiar contraseña" }),
    ).toBeTruthy();
  });

  it("AC-02 asks for the current password and focuses it", async () => {
    const { transport } = open(() => new Response(null, { status: 204 }));
    const region = await fill("", "a-new-password-123");
    submit(region);
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toBe("Ingresa tu contraseña actual.");
    const field = within(region).getByLabelText(CURRENT);
    expect(document.activeElement).toBe(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(transport.calls(CHANGE)).toHaveLength(0);
  });

  it("AC-02 rejects a new password outside 8..256 characters", async () => {
    const { transport } = open(() => new Response(null, { status: 204 }));
    for (const next of ["short", "x".repeat(257)]) {
      const region = await fill("old-password-1", next);
      submit(region);
      const alert = await within(region).findByRole("alert");
      expect(alert.textContent).toBe(
        "La contraseña nueva debe tener entre 8 y 256 caracteres.",
      );
      const field = within(region).getByLabelText(NEXT);
      expect(document.activeElement).toBe(field);
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    }
    expect(transport.calls(CHANGE)).toHaveLength(0);
  });

  it.each([
    [
      "INVALID_CURRENT_PASSWORD",
      () => errorResponse(400, "INVALID_CURRENT_PASSWORD"),
      "La contraseña actual no es correcta.",
    ],
    [
      "PASSWORD_REUSE",
      () => errorResponse(400, "PASSWORD_REUSE"),
      "La nueva contraseña debe ser distinta de la actual.",
    ],
    [
      "VALIDATION_ERROR",
      () => errorResponse(400, "VALIDATION_ERROR", { newPassword: "bad" }),
      "La contraseña nueva debe tener entre 8 y 256 caracteres.",
    ],
    [
      "RATE_LIMITED",
      () =>
        new Response(
          JSON.stringify({ error: { code: "RATE_LIMITED", message: "x" } }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "300",
            },
          },
        ),
      "Demasiados intentos. Espera 5 min.",
    ],
    [
      "RETRYABLE_CONFLICT",
      () => errorResponse(503, "RETRYABLE_CONFLICT"),
      "El sistema está ocupado. Intenta nuevamente en unos segundos.",
    ],
  ])("AC-03 maps %s and keeps the session", async (_code, reply, text) => {
    const { transport } = open(reply);
    const region = await fill("old-password-1", "a-new-password-123");
    submit(region);
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toBe(text);
    expect(screen.getByRole("heading", { name: "Mi perfil" })).toBeTruthy();
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(1);
  });

  it("AC-03 reports a network failure", async () => {
    open(() => {
      throw new TypeError("network down");
    });
    const region = await fill("old-password-1", "a-new-password-123");
    submit(region);
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent).toContain("No fue posible conectar");
  });

  it("AC-04 rotates the session, stays on /profile and toasts once", async () => {
    const { transport } = open(() => new Response(null, { status: 204 }));
    const region = await fill("old-password-1", "a-new-password-123");
    submit(region);

    expect(await screen.findByText("Contraseña actualizada.")).toBeTruthy();
    expect(window.location.pathname).toBe("/profile");
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
    expect(screen.getAllByText("Contraseña actualizada.")).toHaveLength(1);
    const fresh = await section();
    expect(
      (within(fresh).getByLabelText(CURRENT) as HTMLInputElement).value,
    ).toBe("");
    expect((within(fresh).getByLabelText(NEXT) as HTMLInputElement).value).toBe(
      "",
    );
    expect(transport.calls(CHANGE)[0].body).toEqual({
      currentPassword: "old-password-1",
      newPassword: "a-new-password-123",
    });
  });

  it("AC-04 keeps the profile on screen while the rotated session refetches it", async () => {
    const refetch = deferred<Response>();
    let profileCalls = 0;
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        ++profileCalls === 1
          ? jsonResponse({ profile: profileFixture() })
          : refetch.promise,
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [CHANGE]: () => new Response(null, { status: 204 }),
    });
    renderApp({ route: "/profile" });
    const region = await fill("old-password-1", "a-new-password-123");
    submit(region);

    // The new partition's profile request is still open: no loading state.
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
    expect(await screen.findByText("Contraseña actualizada.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mi perfil" })).toBeTruthy();
    expect(document.querySelector('[data-screen="loading"]')).toBeNull();

    refetch.resolve(jsonResponse({ profile: profileFixture() }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Mi perfil" })).toBeTruthy(),
    );
  });

  it("AC-05 sends one request for a double submit and disables the button", async () => {
    const gate = deferred<Response>();
    const { transport } = open(() => gate.promise);
    const region = await fill("old-password-1", "a-new-password-123");
    submit(region);
    submit(region);
    fireEvent.submit(within(region).getByLabelText(NEXT).closest("form")!);

    const button = await within(region).findByRole("button", {
      name: /cambiar contraseña|cambiando/i,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(transport.calls(CHANGE)).toHaveLength(1);
    gate.resolve(new Response(null, { status: 204 }));
    await screen.findByText("Contraseña actualizada.");
  });

  it("AC-06 states the consequence once, next to the button", async () => {
    open(() => new Response(null, { status: 204 }));
    const region = await section();
    const line = "Cierra tus otras sesiones y revoca tus tokens de API.";
    expect(within(region).getAllByText(line)).toHaveLength(1);
    expect(screen.getAllByText(line)).toHaveLength(1);
    const button = within(region).getByRole("button", {
      name: "Cambiar contraseña",
    });
    expect(button.parentElement).toBe(
      within(region).getByText(line).parentElement,
    );
    // The consequence is also the button's accessible description.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(line);
  });
});
