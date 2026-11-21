import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { norte } from "../../test/invoices";
import {
  jsonResponse,
  membership,
  mockTransport,
  NO_PERMISSIONS,
  profileFixture,
} from "../../test/transport";

// The chunk of the Models screen fails to load, as after a redeploy that
// replaced the hashed files (CR-599).
vi.mock("./screens/ModelsScreen", async () => {
  throw new Error("Failed to fetch dynamically imported module");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Models route chunk failure (CR-599)", () => {
  it("keeps the app mounted and offers a reload instead of a white screen", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({
            memberships: [
              membership({ ...norte, mlEnabled: true }, "USER", {
                permissions: { ...NO_PERMISSIONS, deployModels: true },
                groups: [],
              }),
            ],
          }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: "/models" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No fue posible cargar los modelos.");
    // The shell around the route is still there.
    expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();

    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    fireEvent.click(screen.getByRole("button", { name: "Recargar" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
