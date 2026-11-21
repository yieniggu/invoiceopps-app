import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmAction } from "./ConfirmAction";

afterEach(cleanup);

const mount = (pending: boolean, announce?: string) => (
  <ConfirmAction
    label="Quitar"
    confirmLabel="Confirmar quitar"
    pending={pending}
    announce={announce}
    onConfirm={() => undefined}
  />
);

describe("ConfirmAction pending announcement (CR-562)", () => {
  it("says what is running in a hidden live region while pending, and shows the spinner state", () => {
    const view = render(mount(false, "Quitando persona"));
    expect(screen.queryByText("Quitando persona")).toBeNull();

    view.rerender(mount(true, "Quitando persona"));
    const status = screen.getByText("Quitando persona");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.className).toContain("visually-hidden");
    const trigger = screen.getByRole("button", { name: "Quitar" });
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps the live region when the trigger swaps to confirm and back", () => {
    render(mount(false, "Quitando persona"));
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(
      screen.getByRole("button", { name: "Confirmar quitar" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("renders no live region without an announcement", () => {
    render(mount(true));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
