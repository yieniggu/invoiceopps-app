import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new TypeError("secret detail");
}

describe("ErrorBoundary", () => {
  it("renders its children when nothing fails", () => {
    render(
      <ErrorBoundary message="Algo salió mal.">
        <p>contenido</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("contenido")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows one alert and a reload button on a render error, without its message", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onReload = vi.fn();
    render(
      <ErrorBoundary message="Algo salió mal." onReload={onReload}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toBe("Algo salió mal.");
    expect(screen.queryByText(/secret detail/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Recargar" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret detail");
  });
});
