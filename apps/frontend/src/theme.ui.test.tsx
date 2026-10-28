import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeToggle } from "./components/ThemeToggle";
import { AuthScreen } from "./features/auth/screens/AuthScreen";
import { ChangePasswordScreen } from "./features/auth/screens/ChangePasswordScreen";
import { AppShell } from "./features/navigation/AppShell";
import { resetThemeForTests } from "./lib/theme";
import { installMatchMedia } from "./test/matchMedia";
import { SessionProvider } from "./features/auth/components/SessionProvider";
import { SessionStore } from "./features/auth/session/sessionStore";
import { renderWithClient } from "./test/renderWithClient";

let media: ReturnType<typeof installMatchMedia>;

beforeEach(() => {
  window.localStorage.clear();
  media = installMatchMedia(false);
});
afterEach(() => {
  cleanup();
  media.restore();
  vi.restoreAllMocks();
});

const theme = () => document.documentElement.dataset.theme;
const stored = () => window.localStorage.getItem("invoiceops.theme");
const option = (name: string) => screen.getByRole("button", { name });

describe("ThemeToggle", () => {
  it("is a named group whose options have explicit accessible names", () => {
    render(<ThemeToggle />);
    const group = screen.getByRole("group", { name: "Tema" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Usar tema claro",
      "Usar tema oscuro",
      "Usar preferencia del sistema",
    ]);
    // Label in name: the visible text is part of each accessible name.
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Claro", "Oscuro", "Sistema"]);
  });

  it("marks Sistema as pressed and follows the system when nothing is stored", () => {
    media.setDark(true);
    render(<ThemeToggle />);
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(option("Usar tema claro").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(option("Usar tema oscuro").getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(theme()).toBe("dark");
  });

  it("stores the choice, updates aria-pressed and sets data-theme", () => {
    render(<ThemeToggle />);
    fireEvent.click(option("Usar tema oscuro"));
    expect(stored()).toBe("dark");
    expect(theme()).toBe("dark");
    expect(option("Usar tema oscuro").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(option("Usar tema claro"));
    expect(stored()).toBe("light");
    expect(theme()).toBe("light");
  });

  it("is operable from the keyboard as native buttons", () => {
    render(<ThemeToggle />);
    const dark = option("Usar tema oscuro");
    expect(dark.tagName).toBe("BUTTON");
    expect(dark.getAttribute("type")).toBe("button");
    dark.focus();
    expect(document.activeElement).toBe(dark);
    // Browsers turn Enter/Space on a focused button into a click.
    fireEvent.click(dark);
    expect(stored()).toBe("dark");
  });

  it("Sistema clears the key and follows matchMedia again", () => {
    window.localStorage.setItem("invoiceops.theme", "light");
    media.setDark(true);
    render(<ThemeToggle />);
    expect(theme()).toBe("light");
    fireEvent.click(option("Usar preferencia del sistema"));
    expect(stored()).toBeNull();
    expect(theme()).toBe("dark");
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("reacts live to a system change only while nothing is stored", () => {
    render(<ThemeToggle />);
    expect(theme()).toBe("light");
    act(() => media.setDark(true));
    expect(theme()).toBe("dark");
    act(() => media.setDark(false));
    expect(theme()).toBe("light");
    fireEvent.click(option("Usar tema claro"));
    act(() => media.setDark(true));
    expect(theme()).toBe("light");
  });

  it("applies a storage event from another tab", () => {
    render(<ThemeToggle />);
    act(() => {
      window.localStorage.setItem("invoiceops.theme", "dark");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "invoiceops.theme",
          newValue: "dark",
        }),
      );
    });
    expect(theme()).toBe("dark");
    expect(option("Usar tema oscuro").getAttribute("aria-pressed")).toBe(
      "true",
    );
    act(() => {
      window.localStorage.removeItem("invoiceops.theme");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "invoiceops.theme",
          newValue: null,
        }),
      );
    });
    expect(theme()).toBe("light");
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("works with storage that throws and still follows the system", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    media.setDark(true);
    render(<ThemeToggle />);
    expect(theme()).toBe("dark");
    expect(() => fireEvent.click(option("Usar tema claro"))).not.toThrow();
    act(() => media.setDark(false));
    expect(theme()).toBe("light");
  });

  it("resetThemeForTests drops the in-memory override kept when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const first = render(<ThemeToggle />);
    fireEvent.click(option("Usar tema oscuro"));
    expect(theme()).toBe("dark");
    first.unmount();
    vi.restoreAllMocks();
    resetThemeForTests();
    render(<ThemeToggle />);
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  // Pair of tests: the first leaves an in-memory override behind, the second
  // proves the global beforeEach reset (src/test/setup.ts) cleared it.
  it("leak guard 1/2: leaves an in-memory override behind", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThemeToggle />);
    fireEvent.click(option("Usar tema oscuro"));
    expect(theme()).toBe("dark");
  });

  it("leak guard 2/2: starts clean after the previous test", () => {
    render(<ThemeToggle />);
    expect(
      option("Usar preferencia del sistema").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("removes its listeners on unmount", () => {
    const view = render(<ThemeToggle />);
    expect(media.listenerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(media.listenerCount()).toBe(0);
  });

  it("works without matchMedia", () => {
    media.restore();
    render(<ThemeToggle />);
    expect(theme()).toBe("light");
    fireEvent.click(option("Usar tema oscuro"));
    expect(theme()).toBe("dark");
  });
});

describe("ThemeToggle placement", () => {
  const renderShell = () =>
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell onLogout={vi.fn()} isLoggingOut={false}>
          <h1 id="page-title">Panel principal</h1>
        </AppShell>
      </MemoryRouter>,
    );

  it("sits in the top bar (top-right area), not in the sidebar", () => {
    renderShell();
    const group = screen.getByRole("group", { name: "Tema" });
    expect(group.closest("header.topbar")).not.toBeNull();
    expect(group.closest("aside")).toBeNull();
    expect(
      within(screen.getByRole("complementary")).queryByRole("group", {
        name: "Tema",
      }),
    ).toBeNull();
    // The top bar precedes the page content in document order.
    const main = screen.getByRole("main");
    expect(
      group.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stays usable while the sidebar is collapsed", () => {
    window.localStorage.setItem("invoiceops.sidebar.collapsed", "true");
    renderShell();
    const group = screen.getByRole("group", { name: "Tema" });
    const dark = within(group).getByRole("button", {
      name: "Usar tema oscuro",
    });
    expect(dark.getAttribute("title")).toBe("Usar tema oscuro");
    fireEvent.click(dark);
    expect(stored()).toBe("dark");
  });

  it("renders on the login screen before authenticating", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Tema" })).toBeTruthy();
    fireEvent.click(option("Usar tema oscuro"));
    expect(theme()).toBe("dark");
  });

  it("renders on the change-password screen", () => {
    render(
      <SessionProvider store={new SessionStore()}>
        <ChangePasswordScreen />
      </SessionProvider>,
    );
    expect(screen.getByRole("group", { name: "Tema" })).toBeTruthy();
  });
});
