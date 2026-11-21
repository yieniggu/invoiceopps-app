import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SwitchButton } from "./SwitchButton";

afterEach(cleanup);

describe("SwitchButton", () => {
  it("is a switch whose accessible name starts with its visible text", () => {
    render(
      <SwitchButton
        label="Inferencia"
        context="en facturas nuevas de modelo versión 2"
        checked
        onToggle={() => {}}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Inferencia en facturas nuevas de modelo versión 2",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // Label in name: no aria-label that replaces the visible words.
    expect(toggle.hasAttribute("aria-label")).toBe(false);
    const visible = toggle.querySelector(
      ".pending-label > span:not(.visually-hidden)",
    );
    expect(visible?.textContent).toBe("Inferencia");
  });

  it("toggles on click", () => {
    const onToggle = vi.fn();
    render(
      <SwitchButton label="Sección" checked={false} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Sección" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks and keeps its focus while pending or locked", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SwitchButton label="Sección" checked pending onToggle={onToggle} />,
    );
    const toggle = screen.getByRole("switch", { name: "Sección" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(toggle.hasAttribute("disabled")).toBe(false);

    rerender(
      <SwitchButton label="Sección" checked locked onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Sección" }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
