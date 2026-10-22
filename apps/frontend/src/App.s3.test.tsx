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
  invoiceId: id,
  vendorName: `Proveedor ${id}`,
  invoiceAmountCents: 500001,
  hasPurchaseOrder: true,
  threeWayMatch: true,
  status: "PENDING",
  policyProbability: 0.8,
  policyProbabilitySource: "LOCAL_DEMONSTRATION",
  riskContext: {
    vendorTenureDays: 365,
    previousIncidents12m: 2,
    bankAccountRecentlyChanged: false,
    amountVsVendorMedian: 1.2,
    countryRisk: "medium",
  },
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
});
const audit = (source: string) => ({
  decision: "MANUAL_REVIEW",
  ruleVersion: "policy-v1",
  mode: "PROBABILITY_POLICY",
  policyVersion: "policy-v1",
  manualReviewThreshold: 0.8,
  policyProbability: source === "MODEL_API_FALLBACK" ? null : 0.8,
  policyProbabilitySource: source,
  modelId: source === "MODEL_API" ? "invoice-model" : null,
  modelVersion: source === "MODEL_API" ? "12" : null,
  modelRunId: source === "MODEL_API" ? "run-123" : null,
  recommendation: "MANUAL_REVIEW",
  actor: { name: "Actor histórico", rut: "123456785" },
  correlationId: "correlation-s3",
  createdAt: "2026-10-21T00:01:00Z",
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
      return json({
        invoice: invoice(url.pathname.split("/")[2]),
        auditEvents: [],
      });
    });
  const post = vi.fn<() => Promise<Response>>().mockImplementation(async () =>
    json({
      invoice: {
        invoiceId: "INV-A",
        status: "MANUAL_REVIEW",
        updatedAt: "2026-10-21T00:01:00Z",
      },
      auditEvent: audit("MODEL_API"),
    }),
  );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(input.toString(), "http://test.invalid");
      if (url.pathname === "/profile")
        return json({
          profile: {
            id: "user",
            name: "Persona",
            rut: "123456785",
            email: null,
            username: null,
            memberships: [
              {
                organization: { id: "org", name: "Academia", slug: "academy" },
                role: "STUDENT",
              },
            ],
          },
        });
      if (url.pathname === "/groups") return json({ groups: [] });
      if (url.pathname === "/auth/logout") return json({}, 500);
      if (init?.method === "POST") return post();
      return read(url);
    });
  return { read, post, fetchMock };
}
async function start() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /^Facturas$/ }));
}
async function open(id = "INV-A") {
  fireEvent.click(await screen.findByRole("button", { name: `Ver ${id}` }));
  await screen.findByRole("heading", { name: id });
}
function evaluation() {
  fireEvent.click(screen.getByRole("button", { name: /^Evaluación ML$/ }));
}
function policy() {
  fireEvent.change(
    screen.getByRole("textbox", { name: "Versión de política" }),
    { target: { value: "  policy-v1  " } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Aplicar política" }));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S3 invoice presentation and evaluation HTTP boundary", () => {
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
    "explains detail HTTP %s and can reload without a mutation",
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
      expect(
        screen.queryByRole("button", { name: "Aplicar política" }),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar factura" }),
      );
      await screen.findByRole("heading", { name: "INV-A" });
      expect(api.post).not.toHaveBeenCalled();
    },
  );
  it("uses explicit Spanish fallbacks for unknown codes and absent metadata, without authoritatively inferring a result", async () => {
    const api = http();
    const original = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A"
        ? json({
            invoice: {
              ...invoice(),
              status: "NEW_STATUS",
              riskContext: {
                ...invoice().riskContext,
                countryRisk: "unknown-risk",
              },
            },
            auditEvents: [
              {
                ...audit("UNKNOWN_SOURCE"),
                mode: "NEW_MODE",
                decision: "NEW_DECISION",
                recommendation: null,
              },
            ],
          })
        : original(url),
    );
    await start();
    await open();
    expect(screen.getByText("Valor no reconocido (NEW_STATUS)")).toBeTruthy();
    expect(
      screen.getByText(/Valor no reconocido \(unknown-risk\)/),
    ).toBeTruthy();
    expect(screen.getByText("Valor no reconocido (NEW_MODE)")).toBeTruthy();
    evaluation();
    const result = screen.getByRole("region", {
      name: "Resultado de evaluación",
    });
    expect(result.textContent).toContain(
      "Valor no reconocido (UNKNOWN_SOURCE)",
    );
    expect(result.textContent).toContain("Sin datos de modelo");
    expect(api.post).not.toHaveBeenCalled();
  });
  it("retains pending policy evaluation across destination changes and failed logout", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.post.mockReturnValueOnce(pending.promise);
    await start();
    await open();
    evaluation();
    policy();
    fireEvent.click(screen.getByRole("button", { name: "Mi perfil" }));
    fireEvent.click(screen.getByRole("button", { name: /^Facturas$/ }));
    await open();
    evaluation();
    expect(
      screen.getByRole("button", { name: "Registrando decisión..." }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByText(
      "No fue posible cerrar la sesión. Intenta nuevamente.",
    );
    await open();
    evaluation();
    expect(
      screen.getByRole("button", { name: "Registrando decisión..." }),
    ).toHaveProperty("disabled", true);
    await act(async () =>
      pending.resolve(
        json({
          invoice: {
            invoiceId: "INV-A",
            status: "MANUAL_REVIEW",
            updatedAt: "2026-10-21T00:01:00Z",
          },
          auditEvent: audit("MODEL_API"),
        }),
      ),
    );
    await screen.findByText("Resultado recibido en esta sesión");
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it("rejects a mismatched decision response identity and invalid policy version without a second POST", async () => {
    const api = http();
    api.post.mockResolvedValueOnce(
      json({
        invoice: {
          invoiceId: "INV-B",
          status: "MANUAL_REVIEW",
          updatedAt: "2026-10-21T00:01:00Z",
        },
        auditEvent: audit("MODEL_API"),
      }),
    );
    await start();
    await open();
    evaluation();
    fireEvent.change(screen.getByLabelText("Versión de política"), {
      target: { value: "x".repeat(121) },
    });
    expect(
      screen.getByRole("button", { name: "Aplicar política" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Aplicar política" }));
    expect(api.post).not.toHaveBeenCalled();
    policy();
    await screen.findByRole("alert");
    expect(screen.queryByText("run-123")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Aplicar política" }),
    ).toHaveProperty("disabled", true);
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it("localizes list states and preserves currency cents and bounded search", async () => {
    const api = http();
    await start();
    await screen.findByText("Proveedor INV-A");
    const list = screen.getByRole("region", { name: "Listado de facturas" });
    expect(within(list).getAllByText("Pendiente")).toHaveLength(2);
    expect(within(list).getAllByText(/5\.000,01/)).toHaveLength(2);
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
  it.each(["MODEL_API", "LOCAL_DEMONSTRATION", "MODEL_API_FALLBACK"])(
    "reaches evaluation and presents the actual %s result without inventing metadata",
    async (source) => {
      const api = http();
      api.post.mockResolvedValueOnce(
        json({
          invoice: {
            invoiceId: "INV-A",
            status: "MANUAL_REVIEW",
            updatedAt: "2026-10-21T00:01:00Z",
          },
          auditEvent: audit(source),
        }),
      );
      await start();
      await open();
      evaluation();
      expect(
        screen.getByRole("heading", { name: "Evaluación ML" }),
      ).toBeTruthy();
      expect(screen.getByText(/decide y guarda/i)).toBeTruthy();
      expect(screen.getByText(/no es una simulación/i)).toBeTruthy();
      expect(screen.getByText(/Demostración local/)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Aplicar política" }),
      ).toHaveProperty("disabled", true);
      policy();
      await screen.findByText("Resultado recibido en esta sesión");
      const result = screen.getByRole("region", {
        name: "Resultado de evaluación",
      });
      expect(result.textContent).toContain(
        source === "MODEL_API"
          ? "Modelo mediante servidor"
          : source === "LOCAL_DEMONSTRATION"
            ? "Demostración local"
            : "Respaldo: revisión manual",
      );
      expect(result.textContent).toContain(
        source === "MODEL_API" ? "run-123" : "Sin datos de modelo",
      );
      expect(result.textContent).toContain("0,8");
      expect(screen.getByText(/mayor o igual al umbral/)).toBeTruthy();
      const call = api.fetchMock.mock.calls.find(
        ([, init]) => init?.method === "POST",
      );
      expect(call?.[0].toString()).toBe(
        "/invoices/INV-A/decision?organizationId=org&ownerType=user&ownerId=user",
      );
      expect(call?.[1]?.body).toBe(
        JSON.stringify({
          mode: "PROBABILITY_POLICY",
          policyVersion: "policy-v1",
        }),
      );
      expect(
        api.fetchMock.mock.calls.every(
          ([input]) =>
            !/business-policies|mlflow|predict/.test(input.toString()),
        ),
      ).toBe(true);
    },
  );
  it("separates historical evaluation from fresh results and preserves untranslated technical identifiers", async () => {
    const api = http();
    const original = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A"
        ? json({
            invoice: { ...invoice(), status: "MANUAL_REVIEW" },
            auditEvents: [audit("MODEL_API")],
          })
        : original(url),
    );
    await start();
    await open();
    evaluation();
    expect(
      screen.getByText("Última evaluación histórica registrada"),
    ).toBeTruthy();
    expect(screen.queryByText("Resultado recibido en esta sesión")).toBeNull();
    expect(screen.getAllByText("policy-v1").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: "Aplicar política" }),
    ).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("keeps one pending ledger across evaluation/detail/list and isolates late response JSON from invoice B", async () => {
    const api = http();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.post.mockResolvedValueOnce(response);
    await start();
    await open();
    evaluation();
    policy();
    await waitFor(() => expect(parse).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /^Detalle de factura$/ }),
    );
    expect(
      screen.getByRole("button", { name: "Registrando decisión..." }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Volver a facturas" }));
    await open("INV-B");
    evaluation();
    await act(async () =>
      body.resolve({
        invoice: {
          invoiceId: "INV-A",
          status: "MANUAL_REVIEW",
          updatedAt: "now",
        },
        auditEvent: audit("MODEL_API"),
      }),
    );
    expect(screen.queryByText("run-123")).toBeNull();
    expect(screen.queryByText("Resultado recibido en esta sesión")).toBeNull();
    expect(screen.getByRole("heading", { name: "INV-B" })).toBeTruthy();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it.each([403, 404, 409])(
    "explains decision HTTP %s and requires a fresh GET before another decision",
    async (status) => {
      const api = http();
      api.post.mockResolvedValueOnce(json({}, status));
      await start();
      await open();
      evaluation();
      policy();
      expect((await screen.findByRole("alert")).textContent).toContain(
        status === 403 ? "permiso" : status === 404 ? "disponible" : "cambió",
      );
      expect(
        screen.getByRole("button", { name: "Aplicar política" }),
      ).toHaveProperty("disabled", true);
      fireEvent.click(
        screen.getByRole("button", { name: "Consultar estado de la decisión" }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Aplicar política" }),
        ).toHaveProperty("disabled", false),
      );
      expect(api.post).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves completed evaluation metadata across detail/list and destination return without another POST", async () => {
    const api = http();
    await start();
    await open();
    evaluation();
    policy();
    await screen.findByText("Resultado recibido en esta sesión");
    fireEvent.click(
      screen.getByRole("button", { name: /^Detalle de factura$/ }),
    );
    expect(screen.getByText("Ejecución: run-123")).toBeTruthy();
    expect(screen.getByText("Actor histórico (123456785)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Volver a facturas" }));
    const list = screen.getByRole("region", { name: "Listado de facturas" });
    expect(within(list).getByText("Revisión manual")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mi perfil" }));
    fireEvent.click(screen.getByRole("button", { name: /^Facturas$/ }));
    await open();
    evaluation();
    expect(screen.getByText("Resultado recibido en esta sesión")).toBeTruthy();
    expect(screen.getByText("run-123")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Aplicar política" }),
    ).toBeNull();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
