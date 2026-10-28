import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PasswordInput } from "./components/PasswordInput";
import { AuthScreen } from "./features/auth/screens/AuthScreen";
import { ChangePasswordScreen } from "./features/auth/screens/ChangePasswordScreen";
import { SessionProvider } from "./features/auth/components/SessionProvider";
import { SessionStore } from "./features/auth/session/sessionStore";
import { renderWithClient } from "./test/renderWithClient";

afterEach(cleanup);

function Harness({ onSubmit = vi.fn() }: { onSubmit?: () => void }) {
  const [value, setValue] = useState("secreto-123");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <PasswordInput
        label="Contraseña"
        autoComplete="current-password"
        name="password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    </form>
  );
}

describe("PasswordInput", () => {
  it("hides the value by default and toggles it with an accessible, pressed button", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Contraseña") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Mostrar contraseña" });
    expect(input.type).toBe("password");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(input.id);
    expect(toggle.getAttribute("type")).toBe("button");

    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    // One mechanism: the name never changes, only aria-pressed does.
    const pressed = screen.getByRole("button", { name: "Mostrar contraseña" });
    expect(pressed).toBe(toggle);
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    expect(pressed.getAttribute("aria-label")).toBe("Mostrar contraseña");
    expect(
      screen.queryByRole("button", { name: "Ocultar contraseña" }),
    ).toBeNull();
    expect(input.value).toBe("secreto-123");

    fireEvent.click(pressed);
    expect(input.type).toBe("password");
    expect(
      screen
        .getByRole("button", { name: "Mostrar contraseña" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("does not submit the form, keeps focus on the button and preserves attributes", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Contraseña") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Mostrar contraseña" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle);
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.name).toBe("password");
  });

  it("disables the toggle together with the input", () => {
    render(
      <PasswordInput
        label="Contraseña"
        value=""
        onChange={() => {}}
        disabled
      />,
    );
    expect(
      screen.getByRole("button", { name: "Mostrar contraseña" }),
    ).toHaveProperty("disabled", true);
  });
});

describe("password fields in the auth screens", () => {
  it("offers the toggle on the login password and keeps current-password", () => {
    renderWithClient(<AuthScreen onLogin={vi.fn()} />);
    const input = screen.getByLabelText("Contraseña") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    fireEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(input.type).toBe("text");
  });

  it("offers one toggle per field on the forced change-password screen", () => {
    render(
      <SessionProvider store={new SessionStore()}>
        <ChangePasswordScreen />
      </SessionProvider>,
    );
    expect(
      screen.getAllByRole("button", { name: "Mostrar contraseña" }),
    ).toHaveLength(2);
    expect(
      screen.getByLabelText("Contraseña temporal").getAttribute("autocomplete"),
    ).toBe("current-password");
    expect(
      screen.getByLabelText("Contraseña nueva").getAttribute("autocomplete"),
    ).toBe("new-password");
  });
});
