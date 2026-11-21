import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { norte } from "../../test/invoices";
import {
  deferred,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "../../test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(role: "ADMIN" | "USER", mlEnabled: boolean) {
  const state = { mlEnabled };
  const transport = mockTransport({
    "GET /api/v1/auth/profile": () =>
      jsonResponse({
        profile: profileFixture({
          memberships: [
            membership({ ...norte, mlEnabled: state.mlEnabled }, role),
          ],
        }),
      }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET /api/v1/organizations/${norte.id}`]: () =>
      jsonResponse({
        organization: {
          ...norte,
          slug: "norte",
          description: null,
          mlEnabled: state.mlEnabled,
        },
        summary: { memberCount: 3, groupCount: 1 },
      }),
    [`PATCH /api/v1/organizations/${norte.id}`]: (request) => {
      state.mlEnabled = (request.body as { mlEnabled: boolean }).mlEnabled;
      return jsonResponse({
        organization: {
          ...norte,
          slug: "norte",
          description: null,
          mlEnabled: state.mlEnabled,
        },
      });
    },
  });
  return transport;
}

describe("MLOPS-05 organization switch for the Models section", () => {
  it("lets an ADMIN turn it on, then shows «Modelos» in the navigation", async () => {
    const transport = setup("ADMIN", false);
    renderApp({ route: `/organizations/${norte.id}` });

    const toggle = await screen.findByRole("switch", {
      name: "Sección Modelos",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("link", { name: "Modelos" })).toBeNull();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Sección Modelos" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`)[0]!.body,
    ).toEqual({
      mlEnabled: true,
    });
    expect(await screen.findByRole("link", { name: "Modelos" })).toBeTruthy();
  });

  it("turns it on without asking (CR-573)", async () => {
    const transport = setup("ADMIN", false);
    renderApp({ route: `/organizations/${norte.id}` });
    fireEvent.click(
      await screen.findByRole("switch", { name: "Sección Modelos" }),
    );
    // No confirmation step: the request goes out at once.
    await waitFor(() =>
      expect(
        transport.calls(`PATCH /api/v1/organizations/${norte.id}`),
      ).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: /^Confirmar/ })).toBeNull();
  });

  it("asks before turning it off, and sends nothing until confirmed (CR-573)", async () => {
    const transport = setup("ADMIN", true);
    renderApp({ route: `/organizations/${norte.id}` });
    const toggle = await screen.findByRole("switch", {
      name: "Sección Modelos",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(
      await screen.findByRole("button", { name: "Confirmar: desactivar" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`),
    ).toHaveLength(0);

    // Cancelling leaves it on, with the switch back and focused.
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Sección Modelos" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("switch", { name: "Sección Modelos" }),
    );
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("switch", { name: "Sección Modelos" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar: desactivar" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Sección Modelos" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`),
    ).toHaveLength(1);
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`)[0]!.body,
    ).toEqual({ mlEnabled: false });
  });

  it("has one name for the switch: no heading repeats it, and it names itself in its text (CR-563, CR-565)", async () => {
    setup("ADMIN", true);
    renderApp({ route: `/organizations/${norte.id}` });
    const toggle = await screen.findByRole("switch", {
      name: "Sección Modelos",
    });
    expect(
      screen.queryByRole("heading", { name: "Sección Modelos" }),
    ).toBeNull();
    expect(toggle.hasAttribute("aria-label")).toBe(false);
    expect(within(toggle).getByText("Sección Modelos")).toBeTruthy();
  });

  it("announces the pending change in a hidden live region and marks the switch busy (CR-562)", async () => {
    const gate = deferred<Response>();
    const transport = setup("ADMIN", false);
    transport.routes[`PATCH /api/v1/organizations/${norte.id}`] = () =>
      gate.promise;
    renderApp({ route: `/organizations/${norte.id}` });
    const toggle = await screen.findByRole("switch", {
      name: "Sección Modelos",
    });
    fireEvent.click(toggle);
    const speaking = await screen.findByText("Sección Modelos: guardando");
    expect(speaking.getAttribute("role")).toBe("status");
    expect(speaking.className).toContain("visually-hidden");
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    // A second click while it runs sends nothing more.
    fireEvent.click(toggle);
    expect(
      transport.calls(`PATCH /api/v1/organizations/${norte.id}`),
    ).toHaveLength(1);
    gate.resolve(
      jsonResponse({
        organization: {
          ...norte,
          slug: "norte",
          description: null,
          mlEnabled: false,
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Sección Modelos" })
          .getAttribute("aria-busy"),
      ).toBeNull(),
    );
  });

  it.each([
    ["on", false],
    ["off", true],
  ] as const)(
    "keeps focus on the same switch after turning it %s (CR-580)",
    async (_direction, startsEnabled) => {
      setup("ADMIN", startsEnabled);
      renderApp({ route: `/organizations/${norte.id}` });
      const toggle = await screen.findByRole("switch", {
        name: "Sección Modelos",
      });
      toggle.focus();
      fireEvent.click(toggle);
      if (startsEnabled) {
        fireEvent.click(
          await screen.findByRole("button", { name: "Confirmar: desactivar" }),
        );
      }
      await waitFor(() =>
        expect(
          screen
            .getByRole("switch", { name: "Sección Modelos" })
            .getAttribute("aria-checked"),
        ).toBe(startsEnabled ? "false" : "true"),
      );
      const after = screen.getByRole("switch", { name: "Sección Modelos" });
      await waitFor(() => expect(after.getAttribute("aria-busy")).toBeNull());
      expect(document.activeElement).toBe(after);
      expect(screen.getAllByRole("switch")).toHaveLength(1);
      if (!startsEnabled) expect(after).toBe(toggle);
    },
  );

  it("does not offer the switch to a plain member", async () => {
    setup("USER", true);
    renderApp({ route: `/organizations/${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: norte.name });
    await screen.findByText("Resumen");
    expect(
      screen.queryByRole("switch", { name: "Sección Modelos" }),
    ).toBeNull();
  });
});
