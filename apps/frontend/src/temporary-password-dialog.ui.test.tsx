import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TemporaryPasswordDialog } from "./features/users/components/TemporaryPasswordDialog";

const SECRET = "Tmp-Secret-4821-xyz";
const credential = {
  userId: "00000000-0000-4000-8000-000000000009",
  name: "Diego Rojas",
  temporaryPassword: SECRET,
};

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  setClipboard(undefined);
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function open() {
  const onClose = vi.fn();
  render(<TemporaryPasswordDialog credential={credential} onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "Contraseña temporal" });
  return {
    onClose,
    dialog,
    copy: within(dialog).getByRole("button", { name: "Copiar" }),
    confirm: within(dialog).getByRole("button", {
      name: "Ya copié la contraseña",
    }),
  };
}

describe("TemporaryPasswordDialog (CR-214)", () => {
  it("shows the password once with a copy button and one explicit way to close", () => {
    const { dialog, copy, confirm } = open();
    expect(within(dialog).getByText(SECRET)).toBeTruthy();
    expect(copy.getAttribute("type")).toBe("button");
    expect(confirm.getAttribute("type")).toBe("button");
    // The old "Cerrar" button is gone: only the confirmation closes.
    expect(within(dialog).queryByRole("button", { name: "Cerrar" })).toBeNull();
  });

  it("copies the password to the clipboard and announces it without repeating the secret", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const { dialog, copy } = open();

    fireEvent.click(copy);

    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toBe(
        "Contraseña copiada al portapapeles.",
      ),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(within(dialog).getByRole("status").textContent).not.toContain(
      SECRET,
    );
  });

  it("falls back to selecting the password when the clipboard refuses", async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    });
    const { dialog, copy } = open();

    fireEvent.click(copy);

    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toContain(
        "quedó seleccionada",
      ),
    );
    expect(window.getSelection()?.toString()).toBe(SECRET);
    expect(within(dialog).getByRole("status").textContent).not.toContain(
      SECRET,
    );
  });

  it("falls back to selecting the password when there is no clipboard API", async () => {
    setClipboard(undefined);
    const { dialog, copy } = open();

    fireEvent.click(copy);

    await waitFor(() =>
      expect(within(dialog).getByRole("status").textContent).toContain(
        "Ctrl+C",
      ),
    );
    expect(window.getSelection()?.toString()).toBe(SECRET);
  });

  // AC-14 / CR-116: focus starts on a live control and is not lost to a page
  // that history navigation just replaced.
  it("starts focus on the acknowledge button and takes it back after a popstate", async () => {
    const { confirm } = open();
    expect(document.activeElement).toBe(confirm);

    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(document.activeElement).toBe(confirm));
  });

  it("does not close on Escape: it moves focus to the confirmation button", () => {
    const { dialog, onClose, confirm } = open();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(confirm);
  });

  it("does not close when the backdrop is clicked", () => {
    const { dialog, onClose } = open();

    fireEvent.click(dialog.parentElement as HTMLElement);
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeTruthy();
  });

  it("closes only through the confirmation button", () => {
    const { onClose, confirm } = open();

    fireEvent.click(confirm);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside: Copiar and the confirmation are the only controls", () => {
    const { dialog, copy, confirm } = open();
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("Dialog containment (CR-256)", () => {
  function openOverApp() {
    const onClose = vi.fn();
    const view = render(
      <>
        <button type="button">Fondo</button>
        <TemporaryPasswordDialog credential={credential} onClose={onClose} />
      </>,
    );
    const dialog = screen.getByRole("dialog", { name: "Contraseña temporal" });
    return {
      view,
      onClose,
      dialog,
      copy: within(dialog).getByRole("button", { name: "Copiar" }),
      confirm: within(dialog).getByRole("button", {
        name: "Ya copié la contraseña",
      }),
    };
  }

  it("makes the page behind inert while open and restores it on close", () => {
    const { view } = openOverApp();
    // The app container is the only other child of body.
    expect(view.container.hasAttribute("inert")).toBe(true);
    expect(view.container.contains(screen.getByRole("dialog"))).toBe(false);

    view.unmount();
    expect(view.container.hasAttribute("inert")).toBe(false);
  });

  it("does not inert anything that was already inert, and leaves it inert", () => {
    const other = document.createElement("div");
    other.setAttribute("inert", "");
    document.body.append(other);
    const { view } = openOverApp();
    view.unmount();
    expect(other.hasAttribute("inert")).toBe(true);
    other.remove();
  });

  it("acts on Escape when focus is on body: it moves focus to the confirmation", () => {
    const { confirm, onClose } = openOverApp();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(confirm);
  });

  it("moves Tab and Shift+Tab from body into the dialog, never to the page", () => {
    const { copy, confirm } = openOverApp();
    (document.activeElement as HTMLElement).blur();

    const tab = fireEvent.keyDown(document.body, { key: "Tab" });
    expect(tab).toBe(false); // default prevented: the browser does not move on
    expect(document.activeElement).toBe(copy);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it("returns focus to the opener once the page is reachable again", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <TemporaryPasswordDialog credential={credential} onClose={() => {}} />,
    );
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
