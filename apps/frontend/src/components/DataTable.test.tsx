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

describe("DataTable automation anchors", () => {
  const rows = [
    { id: "1", name: "Uno" },
    { id: "2", name: "Dos" },
  ];
  const columns = [
    { header: "Nombre", cell: ({ name }: { name: string }) => name },
  ];

  it("tags the table and every row when asked", () => {
    render(
      <DataTable
        label="Cosas"
        rows={rows}
        columns={columns}
        testId="things-table"
        rowTestId="things-row"
        rowAttributes={({ id, name }) => ({
          "data-thing-id": id,
          "data-thing-name": name,
        })}
      />,
    );
    const table = screen.getByTestId("things-table");
    expect(table).toBe(screen.getByRole("table", { name: "Cosas" }));
    expect(table.id).toBe("things-table");
    const tagged = screen.getAllByTestId("things-row");
    expect(tagged.map((row) => row.getAttribute("data-thing-id"))).toEqual([
      "1",
      "2",
    ]);
    expect(tagged[1].getAttribute("data-thing-name")).toBe("Dos");
  });

  it("renders no anchor when none is given", () => {
    renderTable();
    const table = screen.getByRole("table", { name: "Facturas" });
    expect(table.hasAttribute("id")).toBe(false);
    expect(table.hasAttribute("data-testid")).toBe(false);
    expect(
      document.querySelector("tbody tr")!.hasAttribute("data-testid"),
    ).toBe(false);
  });
});
