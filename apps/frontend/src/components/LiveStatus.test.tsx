import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveStatus } from "./LiveStatus";

afterEach(cleanup);

const region = () => screen.getByRole("status");

function view(pending: boolean, succeeded: boolean) {
  return (
    <LiveStatus
      pending={pending}
      succeeded={succeeded}
      pendingText="Guardando"
      doneText="Guardado"
    />
  );
}

describe("LiveStatus", () => {
  it("is mounted, empty and hidden from sight before anything happens", () => {
    render(view(false, false));
    expect(region().textContent).toBe("");
    expect(region().className).toContain("visually-hidden");
  });

  it("announces the pending phase and then the finished one", () => {
    const { rerender } = render(view(false, false));
    rerender(view(true, false));
    expect(region().textContent).toBe("Guardando");
    rerender(view(false, true));
    expect(region().textContent).toBe("Guardado");
  });

  it("says nothing when the mutation failed (the alert speaks)", () => {
    const { rerender } = render(view(true, false));
    rerender(view(false, false));
    expect(region().textContent).toBe("");
  });

  it("announces the next run again", () => {
    const { rerender } = render(view(true, false));
    rerender(view(false, true));
    rerender(view(true, false));
    expect(region().textContent).toBe("Guardando");
  });
});
