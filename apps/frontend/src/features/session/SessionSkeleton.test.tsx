import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionSkeleton } from "./SessionSkeleton";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SessionSkeleton", () => {
  it("is a labelled main landmark with an announced status and no generic loading text", () => {
    const { container } = render(<SessionSkeleton />);
    expect(
      screen.getByRole("main", { name: "Preparando tu espacio de trabajo" }),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Preparando tu espacio de trabajo",
    );
    // aria-busy never wraps the status; it only marks the visual skeleton.
    expect(container.querySelector("[aria-busy='true']")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    const busy = container.querySelector("[aria-busy='true']");
    expect(busy?.classList.contains("skeleton-layout")).toBe(true);
    expect(busy?.contains(screen.getByRole("status"))).toBe(false);
    expect(document.body.textContent).not.toContain("Cargando sesión");
  });

  it("renders the visual skeleton only after the delay", () => {
    const { container } = render(<SessionSkeleton />);
    expect(container.querySelector(".skeleton-layout")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector(".skeleton-layout")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector(".skeleton-layout")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Cargando sesión");
  });
});
