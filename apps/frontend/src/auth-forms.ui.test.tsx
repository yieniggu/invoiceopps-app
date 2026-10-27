import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RutField } from "./components/RutField";
import { AuthScreen } from "./features/auth/screens/AuthScreen";
import { caretAfterFormat } from "./lib/rut";
import { renderWithClient } from "./test/renderWithClient";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({ submitted = false }: { submitted?: boolean }) {
  const [value, setValue] = useState("");
  return (
    <RutField
      ariaLabel="RUT de prueba"
      value={value}
      onChange={setValue}
      submitted={submitted}
    />
  );
}

const rutInput = () =>
  screen.getByRole("textbox", { name: "RUT de prueba" }) as HTMLInputElement;

/** Fires a change as if the caret sat at `caret` in the raw value. */
function typeWithCaret(input: HTMLInputElement, raw: string, caret: number) {
  Object.defineProperty(input, "selectionStart", {
    configurable: true,
    get: () => caret,
  });
  Object.defineProperty(input, "selectionEnd", {
    configurable: true,
    get: () => caret,
  });
  fireEvent.change(input, { target: { value: raw } });
  delete (input as unknown as Record<string, unknown>).selectionStart;
  delete (input as unknown as Record<string, unknown>).selectionEnd;
}

describe("RutField (RV-094, RV-121, RV-122)", () => {
  it("keeps the caret where the edit happened when reformatting mid-value", () => {
    render(<Harness />);
    const input = rutInput();
    input.focus();
    fireEvent.change(input, { target: { value: "190347907" } });
    expect(input.value).toBe("19.034.790-7");
    // Insert a digit after "19.0": raw becomes "19.0834.790-7" with the caret
    // right after the inserted "8".
    typeWithCaret(input, "19.0834.790-7", 5);
    expect(input.value).toBe("19.083.479-0");
    expect(input.selectionStart).toBe(5);
    expect(input.selectionEnd).toBe(5);
  });

  it("maps a caret across separators with caretAfterFormat", () => {
    expect(caretAfterFormat("19.0834.790-7", 5, "19.083.479-0")).toBe(5);
    expect(caretAfterFormat("1234567", 7, "123.456-7")).toBe(9);
    expect(caretAfterFormat("12345", 0, "1.234-5")).toBe(0);
    expect(caretAfterFormat("001", 3, "1")).toBe(1);
  });

  it("explains leading zeros with a visible hint", () => {
    render(<Harness />);
    expect(screen.getByText(/ceros a la izquierda/i)).toBeTruthy();
    expect(rutInput().getAttribute("aria-describedby")).toContain(
      screen.getByText(/ceros a la izquierda/i).id,
    );
  });

  it("renders the error inside one persistent aria-live container that never moves", () => {
    render(<Harness />);
    const input = rutInput();
    const live = document.querySelector("[aria-live='polite']") as HTMLElement;
    expect(live).toBeTruthy();
    expect(live.textContent).toBe("");
    fireEvent.change(input, { target: { value: "190347908" } });
    fireEvent.blur(input);
    expect(document.querySelector("[aria-live='polite']")).toBe(live);
    expect(live.textContent).toBe("RUT inválido");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toContain(live.id);
  });

  it("does not touch the announcement while the user keeps typing after the error", () => {
    render(<Harness />);
    const input = rutInput();
    const live = document.querySelector("[aria-live='polite']") as HTMLElement;
    fireEvent.change(input, { target: { value: "190347908" } });
    fireEvent.blur(input);
    expect(live.textContent).toBe("RUT inválido");
    const observer = new MutationObserver(() => {});
    observer.observe(live, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
    fireEvent.change(input, { target: { value: "19034790" } });
    fireEvent.change(input, { target: { value: "1903479" } });
    fireEvent.change(input, { target: { value: "190347" } });
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records).toHaveLength(0);
    expect(live.textContent).toBe("RUT inválido");
  });

  it("clears the message once the RUT becomes valid", () => {
    render(<Harness />);
    const input = rutInput();
    fireEvent.change(input, { target: { value: "190347908" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "190347907" } });
    expect(
      (document.querySelector("[aria-live='polite']") as HTMLElement)
        .textContent,
    ).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });
});

describe("AuthScreen one specific message per field (RV-120)", () => {
  it("names the missing RUT and the missing password separately, without a generic alert", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(screen.getByText("Ingresa tu RUT")).toBeTruthy();
    expect(screen.getByText("Ingresa tu contraseña")).toBeTruthy();
    expect(screen.queryByText(/Completa los datos requeridos/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "RUT" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks only for the password when the RUT is valid", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const password = screen.getByLabelText("Contraseña");
    expect(screen.getByText("Ingresa tu contraseña")).toBeTruthy();
    expect(screen.queryByText("Ingresa tu RUT")).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(password);
  });

  it("reports an invalid RUT and a missing password with their own text, never as two alerts", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "190347908" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    expect(screen.getByText("RUT inválido")).toBeTruthy();
    expect(screen.getByText("Ingresa tu contraseña")).toBeTruthy();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("submits with the keyboard (Enter) from the password field", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ user: {} }), { status: 200 }),
      );
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "190347907" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "secret-password" },
    });
    fireEvent.submit(
      screen.getByRole("textbox", { name: "RUT" }).closest("form")!,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
