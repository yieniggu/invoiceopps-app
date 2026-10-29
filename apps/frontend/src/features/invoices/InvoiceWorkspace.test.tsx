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
  id: "00000000-0000-4000-8000-000000000001",
  memberships: [
    {
      organization: {
        id: "00000000-0000-4000-9000-000000000001",
        name: "AI Academy",
      },
      role: "USER",
    },
  ],
};

function invoice(
  businessId: string,
  supplierName: string,
  amountPesos = 12500,
) {
  return {
    id: `uuid-${businessId}`,
    businessId,
    organizationId: "00000000-0000-4000-9000-000000000001",
    groupId: "00000000-0000-4000-a000-000000000001",
    supplierName,
    amountPesos,
    currency: "CLP",
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    businessStatus: "PENDING",
    processingStatus: "NOT_REQUESTED",
    createdByUserId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-10-25T12:00:00.000Z",
  };
}

describe("APP-06 invoice workspace", () => {
  it("shows the active context list and opens its detail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [invoice("INV-001", "Acme Ltd.", 5000)],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoice: invoice("INV-001", "Acme Ltd.", 12500),
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    expect(await screen.findByText("Acme Ltd.")).toBeTruthy();
    expect(screen.getByText("$5.000")).toBeTruthy();
    expect(screen.getByText("Pendiente")).toBeTruthy();
    expect(screen.getByText("Sin procesamiento")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver INV-001" }));

    expect(
      await screen.findByRole("heading", { name: "INV-001" }),
    ).toBeTruthy();
    expect(screen.getByText("Sin procesamiento")).toBeTruthy();
    expect(screen.getByText("2026-10-25")).toBeTruthy();
    expect(screen.getByText("2026-11-25")).toBeTruthy();
    expect(screen.queryByText("Contexto de riesgo")).toBeNull();
  });

  it("asks for an owner, with no broken subtitle, when the selection is gone", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ invoices: [], nextCursor: null }), {
        status: 200,
      }),
    );
    const { rerender } = render(
      <InvoiceWorkspace profile={profile} groups={[]} />,
    );
    expect(
      await screen.findByText("No hay facturas para este propietario."),
    ).toBeTruthy();
    // The selected organization is revoked while another remains available.
    rerender(
      <InvoiceWorkspace
        profile={{
          ...profile,
          memberships: [
            {
              organization: {
                id: "00000000-0000-4000-9000-000000000002",
                name: "Other Org",
              },
              role: "USER",
            },
          ],
        }}
        groups={[]}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: "Elige un propietario",
      }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("undefined");
    expect(screen.queryByText(/Grupo:/)).toBeNull();
    expect(
      screen.queryByText("No hay facturas para este propietario."),
    ).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
            invoices: [invoice("INV-001", "Acme Ltd.", 5000)],
            nextCursor: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [
              invoice("INV-001", "Acme Ltd.", 5000),
              invoice("INV-002", "Acme Next Ltd.", 2000),
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
      await screen.findByRole("button", { name: "Cargar más" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));

    expect(await screen.findByText("Acme Next Ltd.")).toBeTruthy();
    expect(screen.getAllByText("Acme Ltd.")).toHaveLength(1);
    const nextPageUrl = new URL(
      String(fetchMock.mock.calls[2][0]),
      "http://test",
    );
    expect(nextPageUrl.searchParams.get("organizationId")).toBe(
      "00000000-0000-4000-9000-000000000001",
    );
    expect(nextPageUrl.searchParams.get("ownerType")).toBe("user");
    expect(nextPageUrl.searchParams.get("ownerId")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(nextPageUrl.searchParams.get("q")).toBe("Acme");
    expect(nextPageUrl.searchParams.get("cursor")).toBe("cursor-1");
    expect(screen.queryByRole("button", { name: "Cargar más" })).toBeNull();
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
            invoices: [invoice("INV-OLD", "Old vendor", 5000)],
            nextCursor: "cursor-1",
          }),
          { status: 200 },
        ),
      )
      .mockReturnValueOnce(oldPage)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [invoice("INV-CURRENT", "Current vendor", 2000)],
            nextCursor: null,
          }),
          { status: 200 },
        ),
      );

    render(<InvoiceWorkspace profile={profile} groups={[]} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cargar más" }));
    expect(
      screen.getByRole("button", { name: "Cargando más..." }),
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
});
