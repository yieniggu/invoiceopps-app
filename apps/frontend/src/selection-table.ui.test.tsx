import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionTable } from "./components/SelectionTable";

const styles = readFileSync("src/styles.css", "utf8");

afterEach(cleanup);

const rows = [
  {
    id: "u1",
    name: "Ada Lovelace",
    rut: "12.345.678-5",
    role: "Administrador",
  },
  { id: "u2", name: "Carla Soto", rut: "19.034.790-7", role: "Usuario" },
];

function renderTable(onToggle = vi.fn()) {
  render(
    <SelectionTable
      label="Miembros de la organización"
      rows={rows}
      columns={[
        { header: "Nombre", cell: (row) => row.name },
        { header: "RUT", cell: (row) => row.rut },
        { header: "Rol", cell: (row) => row.role },
      ]}
      isSelected={(id) => id === "u2"}
      allSelected={false}
      someSelected
      onToggle={onToggle}
      onToggleAll={vi.fn()}
    />,
  );
}

describe("SelectionTable (CR-239 stacked rows)", () => {
  it("keeps real table semantics for wide screens", () => {
    renderTable();
    const region = screen.getByRole("region", {
      name: "Miembros de la organización",
    });
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getAllByRole("cell")).toHaveLength(2 * 4);
  });

  it("labels every data cell with its column name for the stacked layout", () => {
    renderTable();
    const row = screen.getByText("Carla Soto").closest("tr") as HTMLElement;
    const cells = [...row.querySelectorAll("td[data-label]")];
    expect(cells.map((cell) => cell.getAttribute("data-label"))).toEqual([
      "Nombre",
      "RUT",
      "Rol",
    ]);
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "Carla Soto",
      "19.034.790-7",
      "Usuario",
    ]);
    // The checkbox cell is not a data column: it has no label to repeat.
    expect(
      row.querySelector("td.select-column")?.hasAttribute("data-label"),
    ).toBe(false);
  });

  it("keeps the selection controls usable", () => {
    const onToggle = vi.fn();
    renderTable(onToggle);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Ada Lovelace" }),
    );
    expect(onToggle).toHaveBeenCalledWith("u1");
    expect(
      screen.getByRole("checkbox", { name: "Seleccionar a Carla Soto" }),
    ).toHaveProperty("checked", true);
  });
});

describe("SelectionTable semantics and focus (CR-265)", () => {
  it("states every table role explicitly, so display: block cannot drop them", () => {
    renderTable();
    const table = screen.getByRole("table");
    expect(table.getAttribute("role")).toBe("table");
    for (const group of table.querySelectorAll("thead, tbody"))
      expect(group.getAttribute("role")).toBe("rowgroup");
    for (const row of table.querySelectorAll("tr"))
      expect(row.getAttribute("role")).toBe("row");
    for (const header of table.querySelectorAll("th"))
      expect(header.getAttribute("role")).toBe("columnheader");
    for (const cell of table.querySelectorAll("td"))
      expect(cell.getAttribute("role")).toBe("cell");
  });

  it("names the select-all checkbox with a real, visible-on-narrow label", () => {
    renderTable();
    const all = screen.getByRole("checkbox", { name: "Seleccionar todos" });
    const label = all.closest("label") as HTMLLabelElement;
    expect(label).toBeTruthy();
    expect(label.textContent).toBe("Seleccionar todos");
    // The text is the label itself, not an aria-label that nobody can click.
    expect(all.hasAttribute("aria-label")).toBe(false);
    expect(screen.getByLabelText("Seleccionar todos")).toBe(all);
  });

  it("is not a tab stop while it does not scroll, and is one while it does", async () => {
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
    const width = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockImplementation(() => scrollWidth);
    const client = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(400);
    try {
      renderTable();
      const region = screen.getByRole("region", {
        name: "Miembros de la organización",
      });
      expect(region.hasAttribute("tabindex")).toBe(false);

      scrollWidth = 640;
      await act(async () => observers.forEach((notify) => notify()));
      expect(region.getAttribute("tabindex")).toBe("0");

      scrollWidth = 400;
      await act(async () => observers.forEach((notify) => notify()));
      expect(region.hasAttribute("tabindex")).toBe(false);
    } finally {
      width.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

/** The `@media` blocks whose query is `query`, in source order. */
function mediaBlocks(query: string) {
  const blocks: string[] = [];
  for (
    let start = styles.indexOf(`@media ${query}`);
    start !== -1;
    start = styles.indexOf(`@media ${query}`, start + 1)
  ) {
    let depth = 0;
    for (
      let index = styles.indexOf("{", start);
      index < styles.length;
      index += 1
    ) {
      if (styles[index] === "{") depth += 1;
      if (styles[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(styles.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return blocks;
}

describe("people table stylesheet (CR-239)", () => {
  // These are stylesheet contracts, not browser geometry: the layout itself is
  // checked in the browser suite at 375 px.
  const people =
    mediaBlocks("(max-width: 40rem)").find((block) =>
      block.includes(".data-table"),
    ) ?? "";

  it("is a wide table by default and stacks below 40rem", () => {
    expect(styles).toMatch(/\.data-table\s*\{[^}]*min-width:\s*40rem/);
    expect(people).not.toBe("");
    expect(people).toMatch(/\.data-table\s*\{\s*min-width:\s*0/);
  });

  it("turns rows into cards that show each column name from data-label", () => {
    expect(people).toMatch(/\.data-table tbody tr\s*\{[^}]*border:/);
    expect(people).toMatch(
      /td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/,
    );
    expect(people).toMatch(/\.data-table tbody td\s*\{[^}]*display:\s*grid/);
  });

  it("hides the column headers visually but keeps a visible select-all label", () => {
    expect(people).toMatch(
      /thead th:not\(\.select-column\)\s*\{[^}]*clip-path/,
    );
    // A real label (not generated content) that stacks into view.
    expect(people).not.toContain('content: "Seleccionar todos"');
    expect(people).toMatch(
      /\.select-all-text\s*\{[^}]*position:\s*static[^}]*clip-path:\s*none/,
    );
    expect(styles).toMatch(/\.select-all-text\s*\{[^}]*clip-path:\s*inset/);
  });
});
