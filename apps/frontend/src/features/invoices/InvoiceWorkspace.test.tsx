import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InvoiceWorkspace } from "./InvoiceWorkspace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const profile = {
  id: "user-1",
  memberships: [
    {
      organization: { id: "organization-1", name: "AI Academy" },
      role: "STUDENT",
    },
  ],
};

describe("APP-06 invoice workspace", () => {
  it("shows the active context list and opens a detail with a human-readable audit event", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-001",
                vendorName: "Acme Ltd.",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoice: {
              invoiceId: "INV-001",
              vendorName: "Acme Ltd.",
              invoiceAmountCents: 500000,
              hasPurchaseOrder: true,
              threeWayMatch: true,
              status: "AUTO_PROCESSED",
              riskContext: {
                vendorTenureDays: 365,
                previousIncidents12m: 0,
                bankAccountRecentlyChanged: false,
                amountVsVendorMedian: 1,
                countryRisk: "medium",
              },
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
            auditEvents: [
              {
                decision: "AUTO_PROCESS",
                ruleVersion: "invoice-rules-v1",
                actor: { name: "Ada Lovelace", rut: "123456785" },
                correlationId: "correlation-1",
                createdAt: "2026-09-21T00:01:00.000Z",
              },
            ],
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    expect(await screen.findByText("Acme Ltd.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver INV-001" }));

    expect(await screen.findByText("Ada Lovelace (123456785)")).toBeTruthy();
    expect(screen.queryByText("user-1")).toBeNull();
  });

  it("shows a recoverable list error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "No fue posible cargar las facturas",
    );
    expect(
      screen.getByRole("button", { name: "Reintentar facturas" }),
    ).toBeTruthy();
  });

  it("loads the next cursor page in the active search context without duplicate invoices", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-001",
                vendorName: "Acme Ltd.",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-001",
                vendorName: "Acme Ltd.",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
              {
                invoiceId: "INV-002",
                vendorName: "Acme Next Ltd.",
                invoiceAmountCents: 200000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    await screen.findByText("No hay facturas para este propietario.");
    fireEvent.change(
      await screen.findByLabelText("Buscar por ID o proveedor"),
      {
        target: { value: "Acme" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(
      await screen.findByRole("button", { name: "Load more" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Acme Next Ltd.")).toBeTruthy();
    expect(screen.getAllByText("Acme Ltd.")).toHaveLength(1);
    const nextPageUrl = new URL(
      String(fetchMock.mock.calls[2][0]),
      "http://test",
    );
    expect(nextPageUrl.searchParams.get("organizationId")).toBe(
      "organization-1",
    );
    expect(nextPageUrl.searchParams.get("ownerType")).toBe("user");
    expect(nextPageUrl.searchParams.get("ownerId")).toBe("user-1");
    expect(nextPageUrl.searchParams.get("q")).toBe("Acme");
    expect(nextPageUrl.searchParams.get("cursor")).toBe("cursor-1");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the current search list when a stale load-more request fails", async () => {
    let rejectOldPage!: (reason?: unknown) => void;
    const oldPage = new Promise<Response>((_, reject) => {
      rejectOldPage = reject;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-OLD",
                vendorName: "Old vendor",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-CURRENT",
                vendorName: "Current vendor",
                invoiceAmountCents: 200000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(
      screen.getByRole("button", { name: "Loading more..." }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Buscar por ID o proveedor"), {
      target: { value: "Current" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));

    expect(await screen.findByText("Current vendor")).toBeTruthy();
    rejectOldPage(new Error("Old page failed"));

    await waitFor(() => {
      expect(screen.getByText("Current vendor")).toBeTruthy();
      expect(screen.queryByText("Old vendor")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("updates the detail and exposes the returned audit event after a decision", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-001",
                vendorName: "Acme Ltd.",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoice: {
              invoiceId: "INV-001",
              vendorName: "Acme Ltd.",
              invoiceAmountCents: 500000,
              hasPurchaseOrder: true,
              threeWayMatch: true,
              status: "PENDING",
              riskContext: {
                vendorTenureDays: 365,
                previousIncidents12m: 0,
                bankAccountRecentlyChanged: false,
                amountVsVendorMedian: 1,
                countryRisk: "medium",
              },
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
            auditEvents: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoice: {
              invoiceId: "INV-001",
              status: "AUTO_PROCESSED",
              updatedAt: "2026-09-21T00:01:00.000Z",
            },
            auditEvent: {
              decision: "AUTO_PROCESS",
              ruleVersion: "invoice-rules-v1",
              actor: { name: "Ada Lovelace", rut: "123456785" },
              correlationId: "correlation-1",
              createdAt: "2026-09-21T00:01:00.000Z",
            },
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver INV-001" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Aplicar Rule v1" }),
    );

    expect(await screen.findByText("Ada Lovelace (123456785)")).toBeTruthy();
    expect(screen.getByText("AUTO_PROCESSED")).toBeTruthy();
  });

  it("offers distinct Rule v1 and policy controls for a pending invoice", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              {
                invoiceId: "INV-001",
                vendorName: "Acme Ltd.",
                invoiceAmountCents: 500000,
                hasPurchaseOrder: true,
                threeWayMatch: true,
                status: "PENDING",
              },
            ],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoice: {
              invoiceId: "INV-001",
              vendorName: "Acme Ltd.",
              invoiceAmountCents: 500000,
              hasPurchaseOrder: true,
              threeWayMatch: true,
              status: "PENDING",
              policyProbability: 0.8,
              policyProbabilitySource: "LOCAL_DEMONSTRATION",
              riskContext: {
                vendorTenureDays: 365,
                previousIncidents12m: 0,
                bankAccountRecentlyChanged: false,
                amountVsVendorMedian: 1,
                countryRisk: "medium",
              },
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:00:00.000Z",
            },
            auditEvents: [],
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Ver INV-001" }));

    expect(
      await screen.findByRole("button", { name: "Aplicar Rule v1" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aplicar policy" })).toBeTruthy();
    expect(screen.getByText(/Fuente:/).textContent).toContain(
      "LOCAL_DEMONSTRATION",
    );
  });
});
