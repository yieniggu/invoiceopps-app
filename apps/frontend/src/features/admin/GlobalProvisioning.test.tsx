import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdministrationScreen } from "./AdministrationScreen";
import type { AdministrationController } from "./administrationOperations";

// Global provisioning: the RUT field and the submit paths of the two separate
// forms (RV-091 resolved: each form reads only its own fields and cleans up
// after a confirmed response).
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const controller = {
  draft: { organizationId: "", userId: "", role: "USER", method: "POST" },
  setDraft: vi.fn(),
  operations: new Map(),
} as unknown as AdministrationController;

function renderScreen(onRetry = vi.fn()) {
  render(
    <AdministrationScreen
      profile={{
        id: "admin-1",
        name: "Admin",
        rut: "123456785",
        email: null,
        username: null,
        isPlatformAdministrator: true,
        memberships: [],
      }}
      discovery={{ kind: "loaded", organizations: [] }}
      controller={controller}
      onGroups={vi.fn()}
      onRetry={onRetry}
      onExecute={vi.fn()}
      onRetryRead={vi.fn()}
    />,
  );
  return screen.getByRole("textbox", {
    name: "RUT de usuario",
  }) as HTMLInputElement;
}

function fillUser(rut: HTMLInputElement, value: string) {
  fireEvent.change(screen.getByLabelText("Nombre de usuario"), {
    target: { value: "Estudiante" },
  });
  fireEvent.change(rut, { target: { value } });
  fireEvent.change(screen.getByLabelText("UUID de organización para usuario"), {
    target: { value: "11111111-1111-4111-8111-111111111111" },
  });
}

function submitUser(rut: HTMLInputElement) {
  fireEvent.submit(rut.closest("form") as HTMLFormElement);
}

describe("GlobalProvisioning RUT field", () => {
  it("auto-formats while typing and drops leading zeros", () => {
    const rut = renderScreen();
    fireEvent.change(rut, { target: { value: "190347907" } });
    expect(rut.value).toBe("19.034.790-7");
    fireEvent.change(rut, { target: { value: " 012345674 " } });
    expect(rut.value).toBe("1.234.567-4");
  });

  it("blocks submit, shows an alert and focuses the RUT when invalid", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const rut = renderScreen();
    fillUser(rut, "190347908");
    submitUser(rut);
    const error = screen.getByText("RUT inválido");
    expect(error.getAttribute("role")).toBe("alert");
    expect(rut.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(rut);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the API form of a valid RUT", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 403 }));
    const rut = renderScreen();
    fillUser(rut, "190347907");
    submitUser(rut);
    await screen.findByText("No tienes permiso para esta operación.");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Estudiante",
      rut: "19034790-7",
    });
  });
});

describe("GlobalProvisioning separate forms (RV-091)", () => {
  function fillOrganization() {
    fireEvent.change(screen.getByLabelText("Nombre de organización"), {
      target: { value: "Nueva Org" },
    });
    fireEvent.change(screen.getByLabelText("Slug de organización"), {
      target: { value: "nueva-org" },
    });
  }

  it("creates an organization from its own form with the user fields empty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ organization: { id: "o1" } }), {
        status: 201,
      }),
    );
    const onRetry = vi.fn();
    renderScreen(onRetry);
    fillOrganization();

    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));

    expect(await screen.findByText("Organización creada.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/platform/organizations");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Nueva Org",
      slug: "nueva-org",
    });
    expect(
      (screen.getByLabelText("Nombre de organización") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(
      (screen.getByLabelText("Slug de organización") as HTMLInputElement).value,
    ).toBe("");
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("provisions a user from its own form with the organization fields empty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ temporaryPassword: "temp-secret-12345" }), {
        status: 201,
      }),
    );
    const onRetry = vi.fn();
    const rut = renderScreen(onRetry);
    fillUser(rut, "190347907");

    fireEvent.click(
      screen.getByRole("button", { name: "Provisionar usuario" }),
    );

    expect(await screen.findByText("temp-secret-12345")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/platform/users");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Estudiante",
      rut: "19034790-7",
      organizationId: "11111111-1111-4111-8111-111111111111",
      role: "USER",
    });
    expect(rut.value).toBe("");
    expect(
      (screen.getByLabelText("Nombre de usuario") as HTMLInputElement).value,
    ).toBe("");
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the two payloads apart when both forms hold data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 201 }));
    const rut = renderScreen();
    fillOrganization();
    fillUser(rut, "190347907");

    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));
    await screen.findByText("Organización creada.");

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/v1/platform/organizations");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("rut");
    // The user form keeps what was typed: only the organization form reset.
    expect(rut.value).toBe("19.034.790-7");
  });

  it.each([
    [
      409,
      { error: { code: "CONFLICT", message: "Slug taken" } },
      "Ya existe una organización con ese slug o un usuario con ese RUT.",
    ],
    [
      403,
      { error: { code: "FORBIDDEN", message: "Forbidden" } },
      "No tienes permiso para esta operación.",
    ],
    [
      400,
      { error: { code: "VALIDATION_ERROR", message: "Invalid organization" } },
      "Revisa los campos e intenta nuevamente.",
    ],
    [
      500,
      { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      "No fue posible completar la operación. Intenta nuevamente.",
    ],
  ])(
    "announces a %i failure as a Spanish alert chosen by status and focuses it",
    async (status, body, text) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), { status }),
      );
      renderScreen();
      fillOrganization();

      fireEvent.click(
        screen.getByRole("button", { name: "Crear organización" }),
      );

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(text);
      expect(document.activeElement).toBe(alert);
      // The English backend message is never rendered.
      expect(screen.queryByText(body.error.message)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
      expect(
        (screen.getByLabelText("Nombre de organización") as HTMLInputElement)
          .value,
      ).toBe("Nueva Org");
    },
  );

  it("keeps success as a status and clears an earlier alert", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("{}", { status: 409 }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    renderScreen();
    fillOrganization();

    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "Organización creada.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a network failure without clearing the form", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    renderScreen();
    fillOrganization();

    fireEvent.click(screen.getByRole("button", { name: "Crear organización" }));

    expect(await screen.findByText(/No fue posible conectar/)).toBeTruthy();
    expect(
      (screen.getByLabelText("Nombre de organización") as HTMLInputElement)
        .value,
    ).toBe("Nueva Org");
  });
});
