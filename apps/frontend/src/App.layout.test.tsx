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
import { ResourceContext } from "./features/resources/ResourceContext";
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";

const styles = readFileSync("src/styles.css", "utf8");

const context = {
  id: "user",
  memberships: [
    { organization: { id: "org", name: "Academia" }, role: "STUDENT" },
  ],
};
const longName = "Experiment" + "x".repeat(143);
const longInvoiceId = "INV-" + "A".repeat(143);
const longVendor = "Vendor" + "B".repeat(143);
const longCorrelation = "correlation-" + "C".repeat(143);
const invoice = {
  invoiceId: longInvoiceId,
  vendorName: longVendor,
  invoiceAmountCents: 10000,
  hasPurchaseOrder: true,
  threeWayMatch: true,
  status: "AUTO_PROCESSED",
  policyProbability: null,
  policyProbabilitySource: null,
  riskContext: {
    vendorTenureDays: 1,
    previousIncidents12m: 0,
    bankAccountRecentlyChanged: false,
    amountVsVendorMedian: 1,
    countryRisk: "low",
  },
  createdAt: "2026-10-21",
  updatedAt: "2026-10-21",
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
  it.each([false, true])(
    "wraps the complete MLflow experiment name with link=%s and constrains its grid item",
    async (linked) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = new URL(input.toString(), "http://test.invalid").pathname;
        if (path === "/resources") return json({ resources: [] });
        if (path === "/mlflow/resources")
          return json({
            experiment: {
              id: "experiment",
              name: longName,
              ...(linked
                ? { url: "https://mlflow.example.test/experiment" }
                : {}),
            },
            runs: [],
            registeredModel: null,
            versions: [],
            truncated: false,
            fetchedAt: "2026-10-21",
          });
        throw new Error(`Unexpected request: ${path}`);
      });
      render(
        <>
          <style>{styles}</style>
          <ResourceContext profile={context} groups={[]} />
        </>,
      );
      const text = await screen.findByText(longName);
      expect(text.textContent).toBe(longName);
      // The content rule must reach fallback spans as well as links.
      expect(getComputedStyle(text).overflowWrap).toBe("anywhere");
      const item = text.parentElement;
      if (!item) throw new Error("Missing experiment container");
      expect(getComputedStyle(item).minWidth).toBe("0px");
      expect(
        getComputedStyle(screen.getByRole("region", { name: "Recursos" }))
          .gridTemplateColumns,
      ).toBe("minmax(0, 1fr)");
      if (linked)
        expect(
          screen.getByRole("link", { name: longName }).getAttribute("href"),
        ).toBe("https://mlflow.example.test/experiment");
    },
  );

  it("keeps invoice and audit tables in named keyboard-scrollable regions with bounded column layout and complete content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(input.toString(), "http://test.invalid").pathname;
      if (path === "/invoices")
        return json({ invoices: [invoice], nextCursor: null });
      if (path === `/invoices/${longInvoiceId}`)
        return json({
          invoice,
          auditEvents: [
            {
              decision: "AUTO_PROCESS",
              ruleVersion: "rules-v1",
              mode: "RULE_V1",
              policyVersion: null,
              manualReviewThreshold: null,
              policyProbability: null,
              policyProbabilitySource: null,
              modelId: null,
              modelVersion: null,
              modelRunId: null,
              recommendation: null,
              actor: { name: "Persona", rut: "123456785" },
              correlationId: longCorrelation,
              createdAt: "2026-10-21",
            },
          ],
        });
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
    await screen.findByText(longCorrelation);
    const audit = screen.getByRole("region", { name: "Auditoría de facturas" });
    expect(audit.tabIndex).toBe(0);
    expect(getComputedStyle(audit).position).toBe("relative");
    expect(getComputedStyle(audit).overflowX).toBe("auto");
    expect(getComputedStyle(within(audit).getByRole("table")).tableLayout).toBe(
      "fixed",
    );
    expect(getComputedStyle(within(audit).getByRole("table")).minWidth).toBe(
      "1024px",
    );
    expect(
      getComputedStyle(within(audit).getByText(longCorrelation)).overflowWrap,
    ).toBe("anywhere");
    expect(screen.getByRole("heading", { name: longInvoiceId })).toBeTruthy();
    expect(screen.getByText(longVendor)).toBeTruthy();
  });
});
