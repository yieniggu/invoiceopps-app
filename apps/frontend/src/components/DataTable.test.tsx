import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "./DataTable";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderTable = () =>
  render(
    <DataTable
      label="Facturas"
      rows={[{ id: "1", name: "Uno" }]}
      columns={[{ header: "Nombre", cell: ({ name }) => name }]}
    />,
  );

describe("DataTable scroll region (CR-383)", () => {
  it("names the region apart from the table", () => {
    renderTable();
    const table = screen.getByRole("table", { name: "Facturas" });
    const region = screen.getByRole("region", { name: "Tabla de Facturas" });
    expect(region).toBe(table.parentElement);
    expect(screen.queryByRole("region", { name: "Facturas" })).toBeNull();
  });

  it("is a tab stop only while it actually overflows", async () => {
    const observers: Array<() => void> = [];
    class FakeResizeObserver {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    let scrollWidth = 400;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => scrollWidth,
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    renderTable();
    const region = screen.getByRole("region", { name: "Tabla de Facturas" });
    expect(region.hasAttribute("tabindex")).toBe(false);

    scrollWidth = 640;
    await act(async () => observers.forEach((notify) => notify()));
    expect(region.getAttribute("tabindex")).toBe("0");

    scrollWidth = 400;
    await act(async () => observers.forEach((notify) => notify()));
    expect(region.hasAttribute("tabindex")).toBe(false);
  });

  it("measures once on mount even without a ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    renderTable();
    expect(
      screen
        .getByRole("region", { name: "Tabla de Facturas" })
        .getAttribute("tabindex"),
    ).toBe("0");
  });
});
