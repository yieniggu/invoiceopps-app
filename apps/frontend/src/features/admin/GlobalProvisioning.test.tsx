import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdministrationScreen } from "./AdministrationScreen";
import type { AdministrationController } from "./administrationOperations";

// Covers only the RUT field of the global provisioning form. Submit success
// handling (reset, state clearing, proxy) is tracked by RV-090/RV-091 and is
// covered by RP0-06/RP0-08.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const controller = {
  draft: { organizationId: "", userId: "", role: "USER", method: "POST" },
  setDraft: vi.fn(),
  operations: new Map(),
} as unknown as AdministrationController;

function renderScreen() {
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
      onRetry={vi.fn()}
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

// The organization fields share the form and are required, so a click on the
// user button is blocked by native validation (RV-091, RP0-06). Submitting the
// form directly keeps these tests independent of that defect.
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      // A rejected response keeps the test off the post-await success path,
      // which RV-091 (RP0-06/RP0-08) tracks separately.
      new Response("{}", { status: 403 }),
    );
    const rut = renderScreen();
    fillUser(rut, "190347907");
    submitUser(rut);
    await screen.findByText(/La operación fue rechazada/);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Estudiante",
      rut: "19034790-7",
    });
  });
});
