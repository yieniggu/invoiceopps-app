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
import { InvoiceWorkspace } from "./features/invoices/InvoiceWorkspace";
import { ResourceContext } from "./features/resources/ResourceContext";
import { MlflowResources } from "./features/resources/MlflowResources";

const organization = { id: "org", name: "Academia", slug: "academy" };
const profile = {
  id: "user-A",
  name: "Persona A",
  rut: "123456785",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  memberships: [{ organization, role: "STUDENT" }],
};
const groups = [
  {
    id: "group-B",
    name: "Grupo B",
    description: null,
    organization,
    members: [],
  },
];
const invoice = (id: string) => ({
  invoiceId: id,
  vendorName: `Proveedor ${id}`,
  invoiceAmountCents: 10000,
  hasPurchaseOrder: true,
  threeWayMatch: true,
  status: "PENDING",
  policyProbability: null,
  policyProbabilitySource: null,
  riskContext: {
    vendorTenureDays: 365,
    previousIncidents12m: 0,
    bankAccountRecentlyChanged: false,
    amountVsVendorMedian: 1,
    countryRisk: "low",
  },
  createdAt: "2026-10-21",
  updatedAt: "2026-10-21",
});
const audit = {
  decision: "AUTO_PROCESS",
  ruleVersion: "invoice-rules-v1",
  mode: "RULE_V1",
  policyVersion: null,
  manualReviewThreshold: null,
  policyProbability: null,
  policyProbabilitySource: null,
  modelId: null,
  modelVersion: null,
  modelRunId: null,
  recommendation: null,
  actor: { name: "Actor A", rut: "123456785" },
  correlationId: "audit-A",
  createdAt: "2026-10-21",
};
const decision = {
  invoice: {
    invoiceId: "INV-A",
    status: "AUTO_PROCESSED",
    updatedAt: "2026-10-22",
  },
  auditEvent: audit,
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function http() {
  let identity = "A";
  const read = vi
    .fn<(url: URL) => Promise<Response>>()
    .mockImplementation(async (url) => {
      if (url.pathname === "/resources")
        return json({
          resources: [
            {
              id: "r",
              label: `Recurso ${url.searchParams.get("ownerId")}`,
              type: "ml",
            },
          ],
        });
      if (url.pathname === "/mlflow/resources")
        return json({
          experiment: { id: "e", name: "Experimento A" },
          runs: [],
          registeredModel: null,
          versions: [],
          truncated: false,
          fetchedAt: "2026-10-21",
        });
      if (url.pathname === "/invoices")
        return json({
          invoices: [invoice("INV-A"), invoice("INV-B")],
          nextCursor: null,
        });
      if (/^\/invoices\/INV-[AB]$/.test(url.pathname))
        return json({
          invoice: invoice(url.pathname.split("/")[2]),
          auditEvents: [],
        });
      throw new Error(`Unexpected read ${url.pathname}`);
    });
  const mutate = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json(decision));
  const unexpected: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(input.toString(), "http://test.invalid");
      if (url.pathname === "/profile")
        return json({
          profile: {
            ...profile,
            id: `user-${identity}`,
            name: `Persona ${identity}`,
          },
        });
      if (url.pathname === "/groups") return json({ groups });
      if (url.pathname === "/auth/logout")
        return new Response(null, { status: 204 });
      if (url.pathname === "/auth/login") {
        identity = "B";
        return json({ user: { id: "user-B" } });
      }
      if (init?.method === "POST" && url.pathname.endsWith("/decision"))
        return mutate();
      try {
        return await read(url);
      } catch (error) {
        unexpected.push(url.pathname);
        throw error;
      }
    });
  return { read, mutate, fetchMock, unexpected };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("button", { name }),
  );
}
async function start(destination: string) {
  render(<App />);
  await screen.findByRole("navigation");
  navigate(destination);
}
async function open(id = "INV-A") {
  fireEvent.click(await screen.findByRole("button", { name: `Ver ${id}` }));
  await screen.findByRole("heading", { name: id });
}
async function submit() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Aplicar Regla v1" }),
  );
}
async function loginB() {
  fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
    target: { value: "123456785" },
  });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: "test-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
  await screen.findByRole("navigation");
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("APP12 S1 CR003-008 regressions", () => {
  it.each(["body", "error"])(
    "CR007 keeps standalone resources expired after a trailing resource %s",
    async (outcome) => {
      const api = http();
      const pending = deferred<Response>();
      api.read.mockImplementation(async (url) =>
        url.pathname === "/resources" ? pending.promise : json({}, 401),
      );
      render(<ResourceContext profile={profile} groups={groups} />);
      await screen.findByText("La sesión expiró. Inicia sesión nuevamente.");
      const count = api.read.mock.calls.length;
      await act(async () => {
        if (outcome === "body")
          pending.resolve(
            json({
              resources: [{ id: "late", label: "Late resource", type: "ml" }],
            }),
          );
        else pending.reject(new Error("Trailing transport error"));
      });
      expect(
        screen.getByText("La sesión expiró. Inicia sesión nuevamente."),
      ).toBeTruthy();
      expect(screen.queryByText("Late resource")).toBeNull();
      expect(api.read).toHaveBeenCalledTimes(count);
    },
  );
  it.each(["Recursos", "Facturas"])(
    "CR003 retains owner keyboard focus in shared %s without stale owner data",
    async (destination) => {
      const api = http();
      await start(destination);
      const selector = await screen.findByRole("combobox", {
        name: "Propietario",
      });
      selector.focus();
      fireEvent.change(selector, { target: { value: "org:group:group-B" } });
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", { name: "Propietario" }),
      );
      await waitFor(() =>
        expect(
          api.read.mock.calls.some(
            ([url]) => url.searchParams.get("ownerId") === "group-B",
          ),
        ).toBe(true),
      );
      expect(screen.queryByText("Recurso user-A")).toBeNull();
    },
  );
  it.each(["Recursos", "Facturas"])(
    "CR003 retains focus in standalone %s",
    async (destination) => {
      http();
      render(
        destination === "Recursos" ? (
          <ResourceContext profile={profile} groups={groups} />
        ) : (
          <InvoiceWorkspace profile={profile} groups={groups} />
        ),
      );
      const selector = screen.getByRole("combobox", { name: "Propietario" });
      selector.focus();
      fireEvent.change(selector, { target: { value: "org:group:group-B" } });
      await waitFor(() => expect(document.activeElement).toBe(selector));
      expect(screen.queryByText("Recurso user-A")).toBeNull();
    },
  );
  it.each(["success", "error", "body"])(
    "CR004 never applies A decision %s to B detail",
    async (outcome) => {
      const api = http();
      const pending = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.mutate.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : pending.promise,
      );
      await start("Facturas");
      await open();
      await submit();
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      fireEvent.click(
        screen.getByRole("button", { name: "Volver a facturas" }),
      );
      await open("INV-B");
      await act(async () => {
        if (outcome === "body") body.resolve(decision);
        else if (outcome === "error")
          pending.reject(new Error("Transport lost"));
        else pending.resolve(json(decision));
      });
      expect(screen.getByRole("heading", { name: "INV-B" })).toBeTruthy();
      expect(screen.getByText("Pendiente")).toBeTruthy();
      expect(screen.queryByText("Actor A (123456785)")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Aplicar Regla v1" }),
      ).toHaveProperty("disabled", false);
    },
  );
  it("CR004 retains a pending operation across destination exit and return, without blind retry", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    await start("Facturas");
    await open();
    await submit();
    navigate("Mi perfil");
    navigate("Facturas");
    await open();
    expect(
      screen.getByRole("button", { name: "Registrando decisión..." }),
    ).toHaveProperty("disabled", true);
    await act(async () => pending.resolve(json(decision)));
    expect(await screen.findByText("Actor A (123456785)")).toBeTruthy();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });
  it("CR004 reconciles an unknown transport outcome with GET before permitting a repeat", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    await start("Facturas");
    await open();
    await submit();
    navigate("Recursos");
    await act(async () => pending.reject(new Error("Unknown commit")));
    navigate("Facturas");
    await open();
    // A fresh detail GET on re-entry reconciles the terminal unknown outcome.
    expect(
      api.read.mock.calls.filter(([url]) => url.pathname === "/invoices/INV-A"),
    ).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Aplicar Regla v1" }),
    ).toHaveProperty("disabled", false);
    await submit();
    expect(api.mutate).toHaveBeenCalledTimes(2);
  });
  it("CR004 blocks retry after transport failure until an explicit detail reconciliation succeeds", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    await start("Facturas");
    await open();
    await submit();
    await act(async () => pending.reject(new Error("Lost response")));
    expect(screen.getByRole("alert").textContent).toContain(
      "resultado es desconocido",
    );
    expect(
      screen.getByRole("button", { name: "Aplicar Regla v1" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("button", { name: "Consultar estado de la decisión" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Aplicar Regla v1" }),
      ).toHaveProperty("disabled", false),
    );
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "error", "body", "401"])(
    "CR004 isolates late mutation %s from a new session",
    async (outcome) => {
      const api = http();
      const pending = deferred<Response>();
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      api.mutate.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(response) : pending.promise,
      );
      await start("Facturas");
      await open();
      await submit();
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      await loginB();
      navigate("Facturas");
      await open();
      const count = api.read.mock.calls.length;
      await act(async () => {
        if (outcome === "body") body.resolve(decision);
        else if (outcome === "error") pending.reject(new Error("Old error"));
        else pending.resolve(json(decision, outcome === "401" ? 401 : 200));
      });
      expect(screen.getByText("Pendiente")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Actor A (123456785)")).toBeNull();
      expect(api.read).toHaveBeenCalledTimes(count);
    },
  );
  it.each(["/resources", "/invoices", "/invoices/INV-A", "/mlflow/resources"])(
    "CR007 expires the current session on protected GET %s 401",
    async (path) => {
      const api = http();
      const original = api.read.getMockImplementation()!;
      api.read.mockImplementation(async (url) =>
        url.pathname === path ? json({}, 401) : original(url),
      );
      await start(path.includes("invoices") ? "Facturas" : "Recursos");
      if (path === "/invoices/INV-A")
        fireEvent.click(
          await screen.findByRole("button", { name: "Ver INV-A" }),
        );
      await screen.findByRole("button", { name: "Iniciar sesión" });
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByLabelText("Contexto de trabajo")).toBeNull();
      expect(screen.queryByText("Experimento A")).toBeNull();
    },
  );
  it.each(["/resources", "/invoices", "/invoices/INV-A", "/mlflow/resources"])(
    "CR007 ignores late old-session %s 401 after unmount",
    async (path) => {
      const api = http();
      const original = api.read.getMockImplementation()!;
      const pending = deferred<Response>();
      let intercepted = false;
      api.read.mockImplementation(async (url) => {
        if (url.pathname === path && !intercepted) {
          intercepted = true;
          return pending.promise;
        }
        return original(url);
      });
      await start(path.includes("invoices") ? "Facturas" : "Recursos");
      if (path === "/invoices/INV-A")
        fireEvent.click(
          await screen.findByRole("button", { name: "Ver INV-A" }),
        );
      await waitFor(() => expect(intercepted).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      await loginB();
      await act(async () => pending.resolve(json({}, 401)));
      navigate("Mi perfil");
      expect(screen.getByText("Persona B")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it.each(["/resources", "/invoices", "/invoices/INV-A", "/mlflow/resources"])(
    "CR007 ignores delayed old-session %s JSON after a current 401",
    async (path) => {
      const api = http();
      const original = api.read.getMockImplementation()!;
      const body = deferred<unknown>();
      const response = json({});
      const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
      let first = true;
      api.read.mockImplementation(async (url) => {
        if (url.pathname === path && first) {
          first = false;
          return response;
        }
        return original(url);
      });
      await start(path.includes("invoices") ? "Facturas" : "Recursos");
      if (path === "/invoices/INV-A")
        fireEvent.click(
          await screen.findByRole("button", { name: "Ver INV-A" }),
        );
      await waitFor(() => expect(parse).toHaveBeenCalled());
      api.read.mockImplementation(async (url) =>
        url.pathname === "/resources" ? json({}, 401) : original(url),
      );
      navigate("Mi perfil");
      navigate("Recursos");
      await screen.findByRole("button", { name: "Iniciar sesión" });
      await loginB();
      await act(async () =>
        body.resolve(
          await (await original(new URL(path, "http://test.invalid"))).json(),
        ),
      );
      navigate("Mi perfil");
      expect(screen.getByText("Persona B")).toBeTruthy();
      expect(screen.queryByText("Experimento A")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it("CR007 clears a stale MLflow snapshot on 401 and stops polling and manual refresh", async () => {
    const api = http();
    const original = api.read.getMockImplementation()!;
    const view = render(
      <MlflowResources
        context={{
          organizationId: "org",
          ownerType: "user",
          ownerId: "user-A",
        }}
      />,
    );
    await screen.findByText("Experimento A");
    vi.useFakeTimers();
    api.read.mockImplementation(async (url) =>
      url.pathname === "/mlflow/resources" ? json({}, 401) : original(url),
    );
    // Visibility refresh uses the production event listener, without waiting a real polling interval.
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(screen.queryByText("Experimento A")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("sesión expiró");
    const count = api.read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(api.read).toHaveBeenCalledTimes(count);
    expect(
      screen.queryByRole("button", { name: "Reintentar MLflow" }),
    ).toBeNull();
    view.unmount();
  });
  it("CR004 does not reconcile uncertainty using a GET started while the mutation was still pending", async () => {
    const api = http();
    const pending = deferred<Response>();
    const detail = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    await start("Facturas");
    await open();
    await submit();
    navigate("Mi perfil");
    navigate("Facturas");
    const original = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A" ? detail.promise : original(url),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Ver INV-A" }));
    await waitFor(() =>
      expect(
        api.read.mock.calls.filter(
          ([url]) => url.pathname === "/invoices/INV-A",
        ),
      ).toHaveLength(2),
    );
    await act(async () => pending.reject(new Error("Unknown outcome")));
    await act(async () =>
      detail.resolve(json({ invoice: invoice("INV-A"), auditEvents: [] })),
    );
    expect(
      screen.getByRole("button", { name: "Aplicar Regla v1" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert").textContent).toContain(
      "resultado es desconocido",
    );
  });
  it("CR004 preserves unknown outcome on reconciliation failure and displays an already committed decision on successful GET", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    await start("Facturas");
    await open();
    await submit();
    await act(async () => pending.reject(new Error("Unknown outcome")));
    const original = api.read.getMockImplementation()!;
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A" ? json({}, 500) : original(url),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Consultar estado de la decisión" }),
    );
    await screen.findByText("No fue posible cargar la factura.");
    expect(screen.getByText(/El resultado es desconocido/)).toBeTruthy();
    api.read.mockImplementation(async (url) =>
      url.pathname === "/invoices/INV-A"
        ? json({
            invoice: { ...invoice("INV-A"), status: "AUTO_PROCESSED" },
            auditEvents: [audit],
          })
        : original(url),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Consultar estado de la decisión" }),
    );
    expect(await screen.findByText("Actor A (123456785)")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Aplicar Regla v1" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });
  it("CR004 retains a pending decision when logout fails without blocking a legitimate logout", async () => {
    const api = http();
    const pending = deferred<Response>();
    api.mutate.mockReturnValueOnce(pending.promise);
    const original = api.fetchMock.getMockImplementation()!;
    api.fetchMock.mockImplementation(async (input, init) =>
      input.toString() === "/auth/logout"
        ? json({}, 500)
        : original(input, init),
    );
    await start("Facturas");
    await open();
    await submit();
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await screen.findByText(
      "No fue posible cerrar la sesión. Intenta nuevamente.",
    );
    await open();
    expect(
      screen.getByRole("button", { name: "Registrando decisión..." }),
    ).toHaveProperty("disabled", true);
    await act(async () => pending.resolve(json(decision)));
    expect(await screen.findByText("Actor A (123456785)")).toBeTruthy();
    expect(api.mutate).toHaveBeenCalledTimes(1);
  });
  it("CR003 does not steal focus on unrelated data refresh", async () => {
    const api = http();
    await start("Recursos");
    await screen.findByText("Experimento A");
    const logout = screen.getByRole("button", { name: "Cerrar sesión" });
    logout.focus();
    const count = api.read.mock.calls.length;
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(api.read.mock.calls.length).toBeGreaterThan(count);
    expect(document.activeElement).toBe(logout);
  });
  it.each([403, 404, 500])(
    "CR007 preserves the session and resource recovery for HTTP %s",
    async (status) => {
      const api = http();
      const original = api.read.getMockImplementation()!;
      let failed = false;
      api.read.mockImplementation(async (url) => {
        if (url.pathname === "/resources" && !failed) {
          failed = true;
          return json({}, status);
        }
        return original(url);
      });
      await start("Recursos");
      expect(
        await screen.findByText("No fue posible cargar los recursos."),
      ).toBeTruthy();
      expect(screen.getByRole("navigation")).toBeTruthy();
      api.read.mockImplementation(original);
      fireEvent.click(
        screen.getByRole("button", { name: "Reintentar recursos" }),
      );
      expect(await screen.findByText("Recurso user-A")).toBeTruthy();
    },
  );
});
