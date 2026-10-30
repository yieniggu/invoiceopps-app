/// <reference types="vite" />

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { invoice, invoicePage, norte, orgReader } from "./test/invoices";
import { renderApp } from "./test/renderApp";
import { jsonResponse, mockTransport } from "./test/transport";

const styles = readFileSync("src/styles.css", "utf8");

const longBusinessId = "INV-" + "A".repeat(143);
const longVendor = "Vendor" + "B".repeat(143);
const long = invoice(1, {
  businessId: longBusinessId,
  supplierName: longVendor,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// These are computed CSS/DOM contracts, not jsdom geometry or browser QA.
describe("CR005 bounded long-content layout contracts", () => {
  it("loads the actual stylesheet for the CSS contract checks", () => {
    expect(styles).toContain(".workspace-table-scroll");
  });
  it("keeps the invoice table in a bounded, locally scrolling region with complete content", async () => {
    // jsdom has no layout: report an overflowing region.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: orgReader() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/invoices": () => invoicePage([long]),
      [`GET /api/v1/invoices/${long.id}`]: () =>
        jsonResponse({ invoice: long }),
    });
    renderApp({ route: "/invoices" });
    render(<style>{styles}</style>);
    const table = await screen.findByRole("table", { name: "Facturas" });
    // CR-354: the scroll area is a named region a keyboard user can focus and
    // scroll; it is the table's own wrapper.
    const region = screen.getByRole("region", { name: "Tabla de Facturas" });
    expect(region).toBe(table.parentElement);
    // CR-383: a tab stop only while it overflows (mocked: jsdom has no layout).
    expect(region.getAttribute("tabindex")).toBe("0");
    region.focus();
    expect(document.activeElement).toBe(region);
    expect(styles).toMatch(/\.workspace-table-scroll:focus-visible\s*{/);
    expect(region.className).toBe("workspace-table-scroll");
    expect(getComputedStyle(region).position).toBe("relative");
    expect(getComputedStyle(region).minWidth).toBe("0px");
    expect(getComputedStyle(region).maxWidth).toBe("100%");
    expect(getComputedStyle(region).overflowX).toBe("auto");
    // The table keeps a minimum width (52rem) and sizes its columns by content, so a
    // narrow viewport scrolls the region instead of squeezing the columns.
    expect(getComputedStyle(table).minWidth).toBe("832px");
    expect(getComputedStyle(table).tableLayout).toBe("auto");
    const cell = within(table).getByRole("cell", { name: longVendor });
    expect(cell.textContent).toBe(longVendor);
    expect(getComputedStyle(cell).overflowWrap).toBe("anywhere");
    expect(
      within(table).getByRole("link", { name: longBusinessId }).textContent,
    ).toBe(longBusinessId);
    expect(
      within(table).getByRole("columnheader", { name: "Número" }),
    ).toBeTruthy();
  });

  it("keeps a very long id complete and wrapping in the detail title", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: orgReader() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [`GET /api/v1/invoices/${long.id}`]: () =>
        jsonResponse({ invoice: long }),
    });
    renderApp({ route: `/invoices/${long.id}?organizationId=${norte.id}` });
    render(<style>{styles}</style>);
    const title = await screen.findByRole("heading", {
      level: 1,
      name: longBusinessId,
    });
    expect(title.textContent).toBe(longBusinessId);
    expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
  });
});
