/// <reference types="vite" />

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";

const styles = readFileSync("src/styles.css", "utf8");

const context = {
  id: "user",
  memberships: [
    { organization: { id: "org", name: "Academia" }, role: "USER" },
  ],
};
const longInvoiceId = "INV-" + "A".repeat(143);
const longVendor = "Vendor" + "B".repeat(143);
const invoice = {
  id: longInvoiceId,
  businessId: longInvoiceId,
  organizationId: "organization-1",
  groupId: "group-1",
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  processingStatus: "NOT_REQUESTED",
  createdByUserId: "user-1",
  supplierName: longVendor,
  amountPesos: 10000,
  businessStatus: "PENDING",
  createdAt: "2026-10-21",
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// These are computed CSS/DOM contracts, not jsdom geometry or browser QA.
describe("CR005 bounded long-content layout contracts", () => {
  it("loads the actual stylesheet for the CSS contract checks", () => {
    expect(styles).toContain(".workspace-table-scroll");
  });
  it("keeps the invoice table in a named keyboard-scrollable region with bounded column layout and complete content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(input.toString(), "http://test.invalid").pathname;
      if (path === "/api/v1/invoices")
        return json({ invoices: [invoice], nextCursor: null });
      if (path === `/api/v1/invoices/${longInvoiceId}`)
        return json({ invoice });
      throw new Error(`Unexpected request: ${path}`);
    });
    render(
      <>
        <style>{styles}</style>
        <InvoiceWorkspace profile={context} groups={[]} />
      </>,
    );
    await screen.findByText(longVendor);
    const list = screen.getByRole("region", { name: "Listado de facturas" });
    expect(list.tabIndex).toBe(0);
    expect(getComputedStyle(list).position).toBe("relative");
    expect(getComputedStyle(list).minWidth).toBe("0px");
    expect(getComputedStyle(list).maxWidth).toBe("100%");
    expect(getComputedStyle(list).overflowX).toBe("auto");
    const table = within(list).getByRole("table");
    expect(getComputedStyle(table).tableLayout).toBe("fixed");
    expect(getComputedStyle(table).minWidth).toBe("768px");
    expect(
      getComputedStyle(within(list).getByText(longInvoiceId)).overflowWrap,
    ).toBe("anywhere");
    expect(
      within(list).getByRole("columnheader", { name: "Detalle" }),
    ).toBeTruthy();
    fireEvent.click(
      within(list).getByRole("button", { name: `Ver ${longInvoiceId}` }),
    );
    await screen.findByRole("heading", { name: longInvoiceId });
    expect(screen.getByText(longVendor)).toBeTruthy();
  });
});
