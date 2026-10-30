import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  invoice,
  invoicePage,
  norte,
  orgReader,
  queryOf,
} from "./test/invoices";
import { renderApp } from "./test/renderApp";
import {
  deferred,
  errorResponse,
  jsonResponse,
  mockTransport,
  type RouteHandler,
} from "./test/transport";

const LIST = "GET /api/v1/invoices";
const first = invoice(1);

function http(list: RouteHandler, detail?: RouteHandler) {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: orgReader() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET /api/v1/organizations/${norte.id}/groups`]: () =>
      jsonResponse({ groups: [] }),
    [LIST]: list,
    [`GET /api/v1/invoices/${first.id}`]:
      detail ?? (() => jsonResponse({ invoice: first })),
  });
}
async function start(route = "/invoices") {
  renderApp({ route });
  await screen.findByRole("heading", { level: 1, name: "Facturas" });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S3 invoice presentation HTTP boundary", () => {
  it("announces initial loading and a genuine empty result, then searches without inventing rows", async () => {
    const pending = deferred<Response>();
    let rows: unknown[] = [];
    const api = http(() => (rows.length ? invoicePage(rows) : pending.promise));
    await start();
    expect(await screen.findByText("Cargando facturas…")).toBeTruthy();
    expect(screen.queryByText(/Todavía no hay facturas/)).toBeNull();
    await act(async () => pending.resolve(invoicePage([])));
    expect(await screen.findByText(/Todavía no hay facturas/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    rows = [first];
    fireEvent.change(screen.getByLabelText("Buscar por número o proveedor"), {
      target: { value: "  Proveedor  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
    await screen.findByText("Proveedor 1");
    const search = queryOf(api.calls(LIST).at(-1)!);
    expect(search.q).toBe("Proveedor");
    expect(search.page).toBe("1");
  });

  it("invalidates the current session on a current 401", async () => {
    let expired = false;
    http(() =>
      expired ? errorResponse(401, "UNAUTHENTICATED") : invoicePage([first]),
    );
    await start();
    await screen.findByText("Proveedor 1");
    expired = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByText("Proveedor 1")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it.each([
    [403, "No tienes permiso para ver esta factura."],
    [500, "No fue posible cargar la factura."],
  ])("explains detail HTTP %s and can reload", async (status, message) => {
    let fail = true;
    http(
      () => invoicePage([first]),
      () =>
        fail ? errorResponse(status, "ERR") : jsonResponse({ invoice: first }),
    );
    await start();
    fireEvent.click(await screen.findByRole("link", { name: "FAC-1" }));
    await screen.findByText(message);
    expect(screen.queryByText("Proveedor 1")).toBeNull();
    fail = false;
    if (status === 403) {
      // The permission check failed: the way back is the inbox.
      expect(
        screen.getByRole("link", { name: "Volver a facturas" }),
      ).toBeTruthy();
      return;
    }
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("heading", { level: 1, name: "FAC-1" });
  });

  it("explains detail HTTP 404 as not found with the way back", async () => {
    http(
      () => invoicePage([first]),
      () => errorResponse(404, "NOT_FOUND"),
    );
    await start();
    fireEvent.click(await screen.findByRole("link", { name: "FAC-1" }));
    await screen.findByRole("heading", {
      level: 1,
      name: "Factura no encontrada",
    });
    fireEvent.click(screen.getByRole("link", { name: "Volver a facturas" }));
    await screen.findByRole("table", { name: "Facturas" });
  });

  it("uses an explicit Spanish fallback for unknown status codes", async () => {
    const odd = invoice(1, { businessStatus: "NEW_STATUS" });
    http(
      () => invoicePage([odd]),
      () => jsonResponse({ invoice: odd }),
    );
    await start();
    const table = await screen.findByRole("table", { name: "Facturas" });
    expect(
      within(table).getByText("Valor no reconocido (NEW_STATUS)"),
    ).toBeTruthy();
    fireEvent.click(within(table).getByRole("link", { name: "FAC-1" }));
    await screen.findByRole("heading", { level: 1, name: "FAC-1" });
    expect(screen.getByText("Valor no reconocido (NEW_STATUS)")).toBeTruthy();
  });

  it("localizes list states, formats whole CLP pesos and bounds search", async () => {
    const api = http(() =>
      invoicePage([
        invoice(1, { amountPesos: 500001 }),
        invoice(2, { amountPesos: 500001 }),
      ]),
    );
    await start();
    const table = await screen.findByRole("table", { name: "Facturas" });
    expect(within(table).getAllByText("Pendiente")).toHaveLength(2);
    expect(within(table).getAllByText("$500.001")).toHaveLength(2);
    expect(
      screen.getByRole("searchbox", { name: "Buscar por número o proveedor" }),
    ).toHaveProperty("maxLength", 120);
    fireEvent.change(screen.getByLabelText("Buscar por número o proveedor"), {
      target: { value: "  Acme  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
    await waitFor(() =>
      expect(queryOf(api.calls(LIST).at(-1)!).q).toBe("Acme"),
    );
  });

  it.each([
    [403, "Ya no tienes permiso"],
    [400, "no son válidos"],
    [500, "No fue posible cargar las facturas."],
  ])(
    "explains list HTTP %s without presenting an empty state and supports retry",
    async (status, text) => {
      let fail = true;
      http(() => (fail ? errorResponse(status, "ERR") : invoicePage([first])));
      await start();
      expect((await screen.findByRole("alert")).textContent).toContain(text);
      expect(screen.queryByText(/Todavía no hay facturas/)).toBeNull();
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      await screen.findByText("Proveedor 1");
      expect(screen.getByRole("navigation")).toBeTruthy();
    },
  );

  it("retries the same page after a page failure, keeping the page in the URL", async () => {
    let fail = true;
    const api = http(({ search }) => {
      const page = Number(new URLSearchParams(search).get("page"));
      if (page === 2 && fail) return errorResponse(500, "ERR");
      return invoicePage([invoice(page)], { page, total: 41 });
    });
    await start(`/invoices?organizationId=${norte.id}`);
    await screen.findByText("Proveedor 1");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar las facturas.",
    );
    expect(screen.queryByText("Proveedor 1")).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByText("Proveedor 2");
    expect(new URLSearchParams(window.location.search).get("page")).toBe("2");
    expect(api.calls(LIST).map((call) => queryOf(call).page)).toEqual([
      "1",
      "2",
      "2",
    ]);
  });
});
