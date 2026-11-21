import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PendingButton } from "./PendingButton";

afterEach(cleanup);

describe("PendingButton", () => {
  it("keeps its label and name, shows a spinner and says it is busy", () => {
    const { container, rerender } = render(
      <PendingButton pending={false}>Guardar</PendingButton>,
    );
    expect(container.querySelector(".pending-spinner")).toBeNull();
    rerender(<PendingButton pending>Guardar</PendingButton>);
    const button = screen.getByRole("button", { name: "Guardar" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.className).toContain("is-pending");
    expect(container.querySelector(".pending-spinner")).not.toBeNull();
    // No text state: the label never turns into «Guardando…».
    expect(button.textContent).toBe("Guardar");
  });

  it("announces through a hidden live region instead of visible text", () => {
    const { rerender } = render(
      <PendingButton pending={false} announce={{ pending: "Guardando perfil" }}>
        Guardar
      </PendingButton>,
    );
    rerender(
      <PendingButton pending announce={{ pending: "Guardando perfil" }}>
        Guardar
      </PendingButton>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Guardando perfil");
    expect(region.className).toContain("visually-hidden");
  });
});
