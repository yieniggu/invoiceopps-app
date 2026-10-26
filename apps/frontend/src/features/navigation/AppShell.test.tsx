import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell, SIDEBAR_COLLAPSED_KEY, type Destination } from "./AppShell";

// jsdom does not implement `inert`; mimic browsers so focusing inside an
// inert subtree is a no-op. This makes focus tests prove effect ordering.
const realFocus = HTMLElement.prototype.focus;
function stubInertFocus() {
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (this.closest("[inert]")) return;
    realFocus.call(this, options);
  });
}

function stubMatchMedia(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const original = window.matchMedia;
  const queries: string[] = [];
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      matches,
      media: query,
      addEventListener: (_: string, listener: never) => listeners.add(listener),
      removeEventListener: (_: string, listener: never) =>
        listeners.delete(listener),
    };
  }) as unknown as typeof window.matchMedia;
  return {
    listeners,
    queries,
    restore: () => {
      window.matchMedia = original;
    },
  };
}

function renderShell({
  canAdministrate = false,
  isLoggingOut = false,
  onLogout = vi.fn(),
  onNavigate = vi.fn(),
  destination = "Panel principal",
  children = <p>Contenido</p>,
}: {
  children?: ReactNode;
  canAdministrate?: boolean;
  isLoggingOut?: boolean;
  onLogout?: () => void;
  onNavigate?: (destination: Destination) => void;
  destination?: Destination;
} = {}) {
  return render(
    <AppShell
      destination={destination}
      onNavigate={onNavigate}
      canAdministrate={canAdministrate}
      onLogout={onLogout}
      isLoggingOut={isLoggingOut}
    >
      {children}
    </AppShell>,
  );
}

const originalInnerWidth = window.innerWidth;
function setInnerWidth(value: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
}

beforeEach(() => {
  window.localStorage.clear();
  stubInertFocus();
  // Narrow by default so the drawer stays open when matchMedia is missing.
  setInnerWidth(600);
});
afterEach(() => {
  setInnerWidth(originalInnerWidth);
  cleanup();
  vi.restoreAllMocks();
});

describe("AppShell sidebar", () => {
  it("lists destinations in order with Mi perfil and Salir in the bottom group", () => {
    renderShell({ canAdministrate: true });
    const nav = screen.getByRole("navigation", {
      name: "Navegación principal",
    });
    const names = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(names).toEqual([
      "Panel principal",
      "Facturas",
      "Políticas",
      "Organizaciones",
      "Mis grupos",
      "Administración",
      "Mi perfil",
      "Salir",
    ]);
    expect(
      within(nav)
        .getByRole("button", { name: "Panel principal" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Panel principal",
    );
  });

  it("hides Administración without administrative authority", () => {
    renderShell({ canAdministrate: false });
    expect(screen.queryByRole("button", { name: "Administración" })).toBeNull();
  });

  it("collapses, keeps accessible names and persists the preference", () => {
    const first = renderShell();
    const toggle = screen.getByRole("button", { name: "Contraer menú" });
    // The label changes with the state, so the toggle exposes no aria-expanded.
    expect(toggle.hasAttribute("aria-expanded")).toBe(false);
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    fireEvent.click(toggle);
    const expand = screen.getByRole("button", { name: "Expandir menú" });
    expect(expand.hasAttribute("aria-expanded")).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("true");
    const facturas = screen.getByRole("button", { name: "Facturas" });
    expect(facturas.getAttribute("title")).toBe("Facturas");
    first.unmount();

    renderShell();
    expect(screen.getByRole("button", { name: "Expandir menú" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expandir menú" }));
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("false");
  });

  it("works when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Contraer menú" }));
    expect(screen.getByRole("button", { name: "Expandir menú" })).toBeTruthy();
  });

  it("calls onLogout from Salir and disables it while logging out", () => {
    const onLogout = vi.fn();
    const view = renderShell({ onLogout });
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    expect(onLogout).toHaveBeenCalledOnce();
    view.unmount();

    renderShell({ isLoggingOut: true });
    const pending = screen.getByRole("button", { name: "Saliendo..." });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
  });

  it("navigates from the sidebar", () => {
    const onNavigate = vi.fn();
    renderShell({ onNavigate });
    fireEvent.click(screen.getByRole("button", { name: "Facturas" }));
    expect(onNavigate).toHaveBeenCalledWith("Facturas");
  });

  it("opens the drawer with focus inside and closes on Escape returning focus to the trigger", () => {
    renderShell();
    const trigger = screen.getByRole("button", { name: "Abrir menú" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cerrar menú" }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the drawer on backdrop click and on navigation", () => {
    const onNavigate = vi.fn();
    const { container } = renderShell({ onNavigate });
    const trigger = screen.getByRole("button", { name: "Abrir menú" });
    fireEvent.click(trigger);
    const backdrop = container.querySelector(".sidebar-backdrop");
    if (!backdrop) throw new Error("Missing backdrop");
    fireEvent.click(backdrop);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Políticas" }));
    expect(onNavigate).toHaveBeenCalledWith("Políticas");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  it("verifies the inert focus stub ignores focus inside inert content while the drawer is open", () => {
    const { container } = renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    const main = container.querySelector("main") as HTMLElement;
    const heading = screen.getByRole("heading", { level: 1 });
    heading.focus();
    expect(main.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).not.toBe(heading);
  });

  it("makes the topbar and main content inert while the drawer is open", () => {
    const { container } = renderShell();
    const main = container.querySelector("main") as HTMLElement;
    const topbar = container.querySelector("header") as HTMLElement;
    expect(main.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    expect(main.hasAttribute("inert")).toBe(true);
    expect(topbar.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(main.hasAttribute("inert")).toBe(false);
    expect(topbar.hasAttribute("inert")).toBe(false);
  });

  it("makes the skip link inert while the drawer is open", () => {
    renderShell();
    const skip = screen.getByRole("link", { name: "Saltar al contenido" });
    expect(skip.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Abrir menú" }));
    expect(skip.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(skip.hasAttribute("inert")).toBe(false);
  });

  it("uses the CSS breakpoint and closes the drawer to the heading when the viewport stops matching", () => {
    const media = stubMatchMedia(true);
    try {
      const { container } = renderShell();
      const trigger = screen.getByRole("button", { name: "Abrir menú" });
      fireEvent.click(trigger);
      expect(media.queries).toEqual(["(max-width: 768px)"]);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      act(() =>
        media.listeners.forEach((listener) => listener({ matches: true })),
      );
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      act(() =>
        media.listeners.forEach((listener) => listener({ matches: false })),
      );
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(
        (container.querySelector("main") as HTMLElement).hasAttribute("inert"),
      ).toBe(false);
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1 }),
      );
    } finally {
      media.restore();
    }
  });

  it("closes immediately when the viewport is already wide as the drawer opens", () => {
    const media = stubMatchMedia(false);
    try {
      renderShell();
      const trigger = screen.getByRole("button", { name: "Abrir menú" });
      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1 }),
      );
    } finally {
      media.restore();
    }
  });

  it("closes the drawer from Salir so main is not inert and a logout error stays perceivable", () => {
    const onLogout = vi.fn();
    const { container } = renderShell({
      onLogout,
      children: <p role="alert">No se pudo cerrar la sesión</p>,
    });
    const trigger = screen.getByRole("button", { name: "Abrir menú" });
    fireEvent.click(trigger);
    const main = container.querySelector("main") as HTMLElement;
    expect(main.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    expect(onLogout).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(main.hasAttribute("inert")).toBe(false);
    const alert = screen.getByRole("alert");
    expect(alert.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
  });

  describe("when matchMedia is unavailable", () => {
    const setWidth = setInnerWidth;

    it("closes the drawer on resize past the breakpoint", () => {
      expect(typeof window.matchMedia).not.toBe("function");
      setWidth(768);
      renderShell();
      const trigger = screen.getByRole("button", { name: "Abrir menú" });
      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      setWidth(1200);
      fireEvent(window, new Event("resize"));
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("keeps the drawer open at exactly 768px", () => {
      setWidth(768);
      renderShell();
      const trigger = screen.getByRole("button", { name: "Abrir menú" });
      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    it("closes immediately at 769px and focuses the heading", () => {
      setWidth(769);
      renderShell();
      const trigger = screen.getByRole("button", { name: "Abrir menú" });
      fireEvent.click(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 1 }),
      );
    });
  });
});
