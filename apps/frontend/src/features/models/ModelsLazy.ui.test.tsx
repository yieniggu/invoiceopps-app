import { cleanup, screen, waitFor } from "@testing-library/react";
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

// The Models screen module is held back until `release`. If the route imported
// it statically, the whole app would wait on it and this file would time out;
// as a lazy chunk the route shows its labelled skeleton meanwhile (CR-596).
const gate = vi.hoisted(() => {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
});

vi.mock("./screens/ModelsScreen", async (importOriginal) => {
  await gate.opened;
  return importOriginal();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Models route chunk (CR-596)", () => {
  it("shows a labelled skeleton while the chunk loads, then the screen", async () => {
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
      "GET /api/v1/models": () =>
        jsonResponse({
          workspace: `org-${norte.id}`,
          mlflowUrl: null,
          truncated: false,
          models: [],
        }),
      "GET /api/v1/deployments": () =>
        jsonResponse({
          items: [],
          limits: { activeCount: 0, maxActive: 3, maxChecksPerHour: 10 },
          modelApiAvailable: true,
        }),
    });
    renderApp({ route: "/models" });

    const status = await screen.findByText("Cargando modelos");
    expect(status.getAttribute("role")).toBe("status");
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: "Modelos" })).toBe(
      null,
    );

    gate.release();
    await screen.findByRole("heading", { level: 1, name: "Modelos" });
    await waitFor(() =>
      expect(screen.queryByText("Cargando modelos")).toBeNull(),
    );
  });
});
