import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  jsonResponse,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PATCH = "PATCH /api/v1/profile";

function open(reply: () => Response) {
  const transport = mockTransport({
    "GET /api/v1/auth/profile": () =>
      jsonResponse({ profile: profileFixture() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [PATCH]: reply,
  });
  renderApp({ route: "/profile" });
  return transport;
}

async function save(email: string, username = "") {
  fireEvent.change(await screen.findByLabelText("Correo electrónico"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("Nombre de usuario"), {
    target: { value: username },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
  return screen.findByRole("alert");
}

describe("profile save errors (CR-310)", () => {
  it("says the email or username is taken on 409 USER_CONFLICT", async () => {
    open(() => errorResponse(409, "USER_CONFLICT"));
    const alert = await save("ada@example.test", "ada");
    expect(alert.textContent).toBe(
      "Ese correo electrónico o nombre de usuario ya lo usa otra persona.",
    );
  });

  it("names the email when the server refuses it with 400", async () => {
    open(() =>
      errorResponse(400, "VALIDATION_ERROR", {
        email: "Must be a valid email address",
      }),
    );
    const alert = await save("ada@example");
    expect(alert.textContent).toBe(
      "El correo electrónico no es válido (máximo 254 caracteres, sin caracteres de control).",
    );
  });

  it("names the username when the server refuses it with 400", async () => {
    open(() =>
      errorResponse(400, "VALIDATION_ERROR", {
        username: "Too big: expected string to have <=64 characters",
      }),
    );
    const alert = await save("", "u".repeat(70));
    expect(alert.textContent).toBe(
      "El nombre de usuario no es válido (máximo 64 caracteres, sin caracteres de control).",
    );
  });

  it("does not blame the length when the server refuses a NUL username", async () => {
    open(() =>
      errorResponse(400, "VALIDATION_ERROR", {
        username: "Must not contain NUL characters",
      }),
    );
    const alert = await save("", "ada\u0000");
    expect(alert.textContent).toBe(
      "El nombre de usuario no es válido (máximo 64 caracteres, sin caracteres de control).",
    );
  });

  it("keeps the generic text for any other failure", async () => {
    open(() => errorResponse(500, "INTERNAL_ERROR"));
    const alert = await save("ada@example.test");
    expect(alert.textContent).toBe(
      "No fue posible actualizar el perfil. Intenta nuevamente.",
    );
  });
});
