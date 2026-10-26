import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const invoice = (id = "INV-A") => ({
  id: id,
  businessId: id,
  organizationId: "organization-1",
  groupId: "group-1",
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  processingStatus: "NOT_REQUESTED",
  createdByUserId: "user-1",
  supplierName: `Proveedor ${id}`,
  amountPesos: 500001,
  businessStatus: "PENDING",
  createdAt: "2026-10-21T00:00:00Z",
});
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function http() {
  const read = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockImplementation(async (url) => {
      if (url.pathname === "/invoices")
        return json({
          invoices: [invoice(), invoice("INV-B")],
          nextCursor: "cursor-original",
        });
      return json({ invoice: invoice(url.pathname.split("/")[2]) });
    });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(input.toString(), "http://test.invalid");
      if (url.pathname === "/profile")
        return json({
          profile: {
            id: "user",
            name: "Persona",
            rut: "12345678-5",
            email: null,
            username: null,
            memberships: [
              {
                organization: { id: "org", name: "Academia", slug: "academy" },
                role: "USER",
              },
            ],
          },
        });
      if (url.pathname === "/groups") return json({ groups: [] });
      if (url.pathname === "/auth/logout") return json({}, 500);
      return read(url);
    });
  return { read, fetchMock };
}
async function start() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Facturas$/ }));
}
async function open(id = "INV-A") {
  fireEvent.click(await screen.findByRole("button", { name: `Ver ${id}` }));
  await screen.findByRole("heading", { name: id });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S3 invoice presentation HTTP boundary", () => {
  it("announces initial loading and a genuine empty result, then searches without inventing rows", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.read.mockReturnValueOnce(pending.promise);
    await start();
    expect(await screen.findByText("Cargando facturas...")).toBeTruthy();
    expect(
      screen.queryByText("No hay facturas para este propietario."),
    ).toBeNull();
    await act(async () =>
      pending.resolve(json({ invoices: [], nextCursor: null })),
    );
    expect(
      screen.getByText("No hay facturas para este propietario."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.change(screen.getByLabelText("Buscar por ID o proveedor"), {
      target: { value: "  Proveedor  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
    await screen.findByText("Proveedor INV-A");
    expect(api.read.mock.calls.at(-1)?.[0].searchParams.get("q")).toBe(
      "Proveedor",
    );
    expect(api.read.mock.calls.at(-1)?.[0].searchParams.has("cursor")).toBe(
      false,
    );
  });
  it.each(["success", "401", "body"])(
    "ignores an obsolete pagination %s after search and does not release the current page lock",
    async (outcome) => {
      const api = http();
      await start();
      await screen.findByText("Proveedor INV-A");
      const old = deferred<Response>();
      const oldBody = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(oldBody.promise);
      api.read.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : old.promise,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText("Buscar por ID o proveedor"), {
        target: { value: "Current" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
      await screen.findByRole("button", { name: "Cargar más" });
      const current = deferred<Response>();
      api.read.mockReturnValueOnce(current.promise);
      fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
      await act(async () => {
        const result = { invoices: [invoice("INV-OLD")], nextCursor: null };
        if (outcome === "body") oldBody.resolve(result);
        else old.resolve(json(result, outcome === "401" ? 401 : 200));
      });
      expect(
        screen.getByRole("button", { name: "Cargando más..." }),
      ).toHaveProperty("disabled", true);
      expect(screen.queryByText("Proveedor INV-OLD")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Iniciar sesión" }),
      ).toBeNull();
      await act(async () =>
        current.resolve(
          json({ invoices: [invoice("INV-C")], nextCursor: null }),
        ),
      );
      expect(screen.getByText("Proveedor INV-C")).toBeTruthy();
      expect(api.read).toHaveBeenCalledTimes(4);
    },
  );
  it("invalidates the current session on a current pagination 401", async () => {
    const api = http();
    await start();
    await screen.findByText("Proveedor INV-A");
    api.read.mockResolvedValueOnce(json({}, 401));
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByText("Proveedor INV-A")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it.each([403, 404, 409])(
    "explains detail HTTP %s and can reload",
    async (status) => {
      const api = http();
      await start();
      await screen.findByText("Proveedor INV-A");
      api.read.mockResolvedValueOnce(json({}, status));
      fireEvent.click(screen.getByRole("button", { name: "Ver INV-A" }));
      await screen.findByText("No fue posible cargar la factura.");
      expect(
        screen.getByText(
          status === 403
            ? /No tienes permiso/
            : status === 404
              ? /no está disponible para tu sesión/
              : /estado de la factura cambió/,
        ),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar factura" }),
      );
      await screen.findByRole("heading", { name: "INV-A" });
    },
  );
  it("uses an explicit Spanish fallback for unknown status codes", async () => {
    const api = http();
    const original = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A"
        ? json({
            invoice: {
              ...invoice(),
              businessStatus: "NEW_STATUS",
            },
          })
        : original(url),
    );
    await start();
    await open();
    expect(screen.getByText("Valor no reconocido (NEW_STATUS)")).toBeTruthy();
  });
  it("localizes list states and formats whole CLP pesos and bounds search", async () => {
    const api = http();
    await start();
    await screen.findByText("Proveedor INV-A");
    const list = screen.getByRole("region", { name: "Listado de facturas" });
    expect(within(list).getAllByText("Pendiente")).toHaveLength(2);
    expect(within(list).getAllByText("$500.001")).toHaveLength(2);
    expect(
      screen.getByRole("textbox", { name: "Buscar por ID o proveedor" }),
    ).toHaveProperty("maxLength", 120);
    fireEvent.change(screen.getByLabelText("Buscar por ID o proveedor"), {
      target: { value: "  Acme  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Buscar$/ }));
    await waitFor(() =>
      expect(api.read.mock.calls.at(-1)?.[0].searchParams.get("q")).toBe(
        "Acme",
      ),
    );
    expect(screen.getByRole("button", { name: "Cargar más" })).toBeTruthy();
  });
  it.each([403, 404, 409])(
    "explains list HTTP %s without presenting a forbidden empty state and supports retry",
    async (status) => {
      const api = http();
      api.read.mockResolvedValueOnce(json({}, status));
      await start();
      expect((await screen.findByRole("alert")).textContent).toContain(
        status === 403 ? "permiso" : status === 404 ? "disponible" : "cambió",
      );
      expect(
        screen.queryByText("No hay facturas para este propietario."),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar facturas" }),
      );
      await screen.findByText("Proveedor INV-A");
      expect(screen.getByRole("navigation")).toBeTruthy();
    },
  );
  it("retains loaded rows on pagination failure and retries the same opaque cursor without overlapping requests", async () => {
    const api = http();
    await start();
    await screen.findByText("Proveedor INV-A");
    const page = deferred<Response>();
    api.read.mockReturnValueOnce(page.promise);
    const more = screen.getByRole("button", { name: "Cargar más" });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(
      screen.getByRole("button", { name: "Cargando más..." }),
    ).toHaveProperty("disabled", true);
    expect(api.read).toHaveBeenCalledTimes(2);
    await act(async () => page.resolve(json({}, 500)));
    expect(screen.getByText("Proveedor INV-A")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("página");
    api.read.mockResolvedValueOnce(
      json({ invoices: [invoice(), invoice("INV-C")], nextCursor: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cargar más" }));
    await screen.findByText("Proveedor INV-C");
    expect(screen.getAllByText("Proveedor INV-A")).toHaveLength(1);
    expect(api.read.mock.calls.at(-1)?.[0].searchParams.get("cursor")).toBe(
      "cursor-original",
    );
  });
});
