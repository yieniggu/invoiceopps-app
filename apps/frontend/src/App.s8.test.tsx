import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Profile } from "./features/profile/ProfileScreen";
import type { InvoiceDetail } from "./features/invoices/InvoiceWorkspace";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const organization = { id: id(1), name: "Academia S8", slug: "academy-s8" };
const recordId = id(4);
const batchId = id(5);
const hash = "0x" + "ab".repeat(32);
const createdAt = "2026-10-21T00:00:00Z";
const invoice: InvoiceDetail = {
  invoiceId: "S8-INVOICE",
  vendorName: "Proveedor S8",
  invoiceAmountCents: 10000,
  hasPurchaseOrder: true,
  threeWayMatch: true,
  status: "PENDING",
  policyProbability: null,
  policyProbabilitySource: null,
  createdAt,
  updatedAt: createdAt,
  riskContext: {
    vendorTenureDays: 365,
    previousIncidents12m: 0,
    bankAccountRecentlyChanged: false,
    amountVsVendorMedian: 1,
    countryRisk: "low",
  },
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function http({ platform = true, member = true, anonymous = false } = {}) {
  let authenticated = !anonymous;
  const profile: Profile = {
    id: id(2),
    name: "Persona S8",
    rut: "123456785",
    email: null,
    username: null,
    isPlatformAdministrator: platform,
    memberships: member ? [{ organization, role: "STUDENT" }] : [],
  };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://test.invalid");
      const method = init?.method ?? "GET";
      if (url.pathname === "/profile" && method === "GET")
        return authenticated ? json({ profile }) : json({}, 401);
      if (url.pathname === "/profile" && method === "PATCH") {
        Object.assign(profile, JSON.parse(String(init?.body)));
        return json({ profile });
      }
      if (url.pathname === "/auth/signup") return json({}, 201);
      if (url.pathname === "/auth/login") {
        authenticated = true;
        return json({});
      }
      if (url.pathname === "/auth/logout") {
        authenticated = false;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/groups")
        return json({
          groups: [
            {
              id: id(3),
              name: "Equipo S8",
              description: null,
              organization,
              members: [
                { id: profile.id, name: profile.name, rut: profile.rut },
              ],
            },
          ],
        });
      if (url.pathname === "/platform/organizations")
        return json({
          organizations: [
            { ...organization, groups: [] },
            { id: id(9), name: "Solo administración", groups: [] },
          ],
        });
      if (url.pathname === "/business-policies" && method === "GET")
        return json({
          policies: [{ version: "s8-policy", manualReviewThreshold: 0.8 }],
        });
      if (url.pathname === "/invoices" && method === "GET")
        return json({ invoices: [invoice], nextCursor: null });
      if (url.pathname === "/invoices/S8-INVOICE" && method === "GET")
        return json({ invoice, auditEvents: [] });
      if (url.pathname === "/invoices/S8-INVOICE/decision" && method === "POST")
        return json({
          invoice: { ...invoice, status: "MANUAL_REVIEW" },
          auditEvent: {
            decision: "MANUAL_REVIEW",
            ruleVersion: "invoice-rules-v1",
            mode: "PROBABILITY_POLICY",
            policyVersion: "s8-policy",
            manualReviewThreshold: 0.8,
            policyProbability: null,
            policyProbabilitySource: "MODEL_API_FALLBACK",
            modelId: null,
            modelVersion: null,
            modelRunId: null,
            recommendation: "MANUAL_REVIEW",
            actor: { name: profile.name, rut: profile.rut },
            correlationId: id(6),
            createdAt,
          },
        });
      if (url.pathname === "/resources") return json({ resources: [] });
      if (url.pathname === "/mlflow/resources")
        return json({
          experiment: { id: "experiment-s8", name: "group/s8/invoice-risk" },
          runs: [{ runId: "run-s8" }],
          registeredModel: { name: "group-s8-invoice-review" },
          versions: [{ version: "01", runId: "run-s8" }],
          truncated: false,
          fetchedAt: createdAt,
        });
      if (url.pathname === "/evidence-records")
        return json({
          items: [
            {
              id: recordId,
              decisionEventId: id(6),
              invoiceRecordId: id(7),
              createdAt,
              evidenceVersion: "invoice-evidence-v2",
              canonicalVersion: "invoice-evidence-canonical-v2",
              leafHash: hash,
              integrity: "not-checked",
            },
          ],
          nextCursor: null,
        });
      if (url.pathname === "/evidence-batches")
        return json({
          items: [
            {
              id: batchId,
              createdAt,
              rootHash: hash,
              leafCount: 1,
              policyVersion: "invoice-merkle-v2",
              integrity: "not-checked",
            },
          ],
          nextCursor: null,
        });
      if (url.pathname === `/evidence-batches/${batchId}`)
        return json({
          batch: {
            id: batchId,
            createdAt,
            rootHash: hash,
            leafCount: 1,
            policyVersion: "invoice-merkle-v2",
            integrity: "server-verified",
            items: [{ recordId, leafIndex: 0 }],
          },
        });
      if (url.pathname === `/evidence-batches/${batchId}/proofs/${recordId}`)
        return json({
          proof: {
            batchId,
            recordId,
            leafHash: hash,
            rootHash: hash,
            leafIndex: 0,
            leafCount: 1,
            policyVersion: "invoice-merkle-v2",
            proof: [],
            integrity: "server-verified",
          },
        });
      throw new Error(`Unexpected S8 boundary: ${method} ${url.pathname}`);
    });
  return fetchMock;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function semantics() {
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  const ids = [...document.querySelectorAll("[id]")].map(
    (element) => element.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  for (const element of document.querySelectorAll(
    "[aria-labelledby], [aria-describedby]",
  )) {
    for (const attribute of ["aria-labelledby", "aria-describedby"]) {
      for (const reference of (element.getAttribute(attribute) ?? "")
        .split(/\s+/)
        .filter(Boolean)) {
        expect(
          document.getElementById(reference),
          `${attribute}=${reference}`,
        ).not.toBeNull();
      }
    }
  }
}
async function navigate(name: string) {
  const nav = await screen.findByRole("navigation", {
    name: "Navegación principal",
  });
  fireEvent.click(within(nav).getByRole("button", { name }));
  expect(screen.getByRole("heading", { level: 1, name })).toBeTruthy();
  expect(
    within(nav).getByRole("button", { name }).getAttribute("aria-current"),
  ).toBe("page");
}
describe("APP12 S8 global acceptance characterization", () => {
  it.each([
    ["Panel principal", "Tu espacio de trabajo"],
    ["Mi perfil", "Datos de contacto"],
    ["Organizaciones", "Mis membresías"],
    ["Mis grupos", "Grupos de mis membresías"],
    ["Facturas", "Facturas"],
    ["Políticas", "Políticas de negocio versionadas"],
    ["Recursos", "Recursos de MLflow"],
    ["Evidencia y lotes", "Consulta de evidencia"],
    ["Administración", "Membresías organizacionales"],
  ])(
    "mounts the real %s surface with Spanish landmarks and valid accessible references",
    async (destination, heading) => {
      const requests = http();
      render(<App />);
      await screen.findByText("Bienvenido, Persona S8");
      expect(
        requests.mock.calls.every(([input]) =>
          ["/profile", "/groups", "/platform/organizations"].includes(
            String(input),
          ),
        ),
      ).toBe(true);
      await navigate(destination);
      await screen.findByRole("heading", {
        level: destination === "Recursos" ? 3 : 2,
        name: heading,
      });
      expect(
        screen.getByLabelText("Contexto de trabajo").textContent,
      ).toContain("Academia S8 · Trabajo individual");
      semantics();
      if (destination === "Mi perfil") {
        fireEvent.change(screen.getByLabelText("Nombre de usuario"), {
          target: { value: "persona-s8" },
        });
        fireEvent.click(
          screen.getByRole("button", { name: "Guardar cambios" }),
        );
        await screen.findByText("Perfil actualizado.");
        expect(
          requests.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]
            ?.body,
        ).toBe(JSON.stringify({ email: "", username: "persona-s8" }));
      }
      if (destination === "Recursos") {
        await screen.findByText("Versión 01");
        expect(
          screen.getByText(/La API actual no expone aliases/),
        ).toBeTruthy();
      }
    },
  );

  it("submits signup and login separately, then establishes authority only through the native profile read", async () => {
    const requests = http({ anonymous: true });
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Crear cuenta" }),
    );
    fireEvent.change(screen.getByLabelText("Nombre"), {
      target: { value: "Persona S8" },
    });
    fireEvent.change(screen.getByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-s8-password" },
    });
    semantics();
    fireEvent.submit(screen.getByRole("form", { name: "Crear cuenta" }));
    await screen.findByText(
      "Cuenta creada. Inicia sesión con tu RUT y contraseña.",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByLabelText("Contraseña")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-s8-password" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Iniciar sesión" }));
    await screen.findByText("Bienvenido, Persona S8");
    expect(
      requests.mock.calls.filter(([input]) => input === "/profile"),
    ).toHaveLength(2);
    for (const path of ["/auth/signup", "/auth/login"]) {
      const request = requests.mock.calls.find(([input]) => input === path);
      expect(request?.[1]?.credentials).toBe("same-origin");
      expect(request?.[1]?.method).toBe("POST");
    }
    semantics();
  });

  it("carries a selected group from policies to detail/evaluation and preserves the server fallback audit without client inference", async () => {
    const requests = http();
    render(<App />);
    await navigate("Mis grupos");
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo S8" }),
    );
    await navigate("Políticas");
    await screen.findByRole("heading", { name: "s8-policy" });
    expect(
      screen.getByText(/Solo lectura. Las políticas grupales/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Editar s8-policy" }),
    ).toBeNull();
    await navigate("Facturas");
    fireEvent.click(
      await screen.findByRole("button", { name: "Ver S8-INVOICE" }),
    );
    await screen.findByRole("heading", { name: "Contexto de riesgo" });
    semantics();
    fireEvent.click(screen.getByRole("button", { name: "Evaluación ML" }));
    fireEvent.change(screen.getByLabelText("Versión de política"), {
      target: { value: "s8-policy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Aplicar política" }));
    const result = await screen.findByRole("region", {
      name: "Resultado de evaluación",
    });
    expect(
      within(result).getByText(/No se recibió una predicción utilizable/),
    ).toBeTruthy();
    expect(within(result).getByText("Sin datos de modelo")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Aplicar política" }),
    ).toBeNull();
    const write = requests.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(write?.[1]?.body).toBe(
      JSON.stringify({
        mode: "PROBABILITY_POLICY",
        policyVersion: "s8-policy",
      }),
    );
    expect(String(write?.[0])).toBe(
      `/invoices/S8-INVOICE/decision?organizationId=${organization.id}&ownerType=group&ownerId=${id(3)}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Detalle de factura" }));
    expect(
      screen.getByRole("region", { name: "Auditoría de facturas" }).textContent,
    ).toContain(id(6));
    expect(screen.getByLabelText("Contexto de trabajo").textContent).toContain(
      "Grupo: Equipo S8",
    );
    expect(
      requests.mock.calls.every(
        ([input, init]) =>
          String(input).startsWith("/") && init?.credentials === "same-origin",
      ),
    ).toBe(true);
    semantics();
  });

  it("opens a native proof only on demand after navigating with group ownership and never offers an anchor write", async () => {
    const requests = http();
    render(<App />);
    await navigate("Mis grupos");
    fireEvent.click(
      await screen.findByRole("button", { name: "Trabajar con Equipo S8" }),
    );
    await navigate("Evidencia y lotes");
    await screen.findByRole("button", { name: `Ver registro ${recordId}` });
    fireEvent.click(screen.getByRole("button", { name: "Lotes" }));
    fireEvent.click(
      await screen.findByRole("button", { name: `Ver lote ${batchId}` }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: `Consultar prueba de ${recordId}`,
      }),
    );
    const proof = await screen.findByRole("region", { name: "Prueba Merkle" });
    await within(proof).findByText("Lote de una hoja: no requiere hermanos.");
    expect(
      within(proof).getByText(
        /no realizó una verificación criptográfica independiente/,
      ),
    ).toBeTruthy();
    expect(
      within(proof).getByText(/un recibo no equivale a finalidad/),
    ).toBeTruthy();
    const reads = requests.mock.calls.filter(([input]) =>
      String(input).startsWith("/evidence-"),
    );
    expect(reads).toHaveLength(4);
    for (const [input, init] of reads) {
      const query = new URL(String(input), "http://test.invalid").searchParams;
      expect(query.get("ownerType")).toBe("group");
      expect(query.get("ownerId")).toBe(id(3));
      expect(init?.method ?? "GET").toBe("GET");
    }
    semantics();
  });

  it.each([false, true])(
    "does not turn platform discovery (%s) into domain access or regular student administration",
    async (platform) => {
      const requests = http({ platform, member: false });
      render(<App />);
      await screen.findByText("Bienvenido, Persona S8");
      expect(
        screen.getByLabelText("Contexto de trabajo").textContent,
      ).toContain("Contexto no disponible");
      for (const destination of [
        "Facturas",
        "Políticas",
        "Recursos",
        "Evidencia y lotes",
      ]) {
        await navigate(destination);
        expect(screen.queryByLabelText("Propietario")).toBeNull();
      }
      expect(
        requests.mock.calls.some(([input]) =>
          /invoices|resources|business-policies|evidence-/.test(String(input)),
        ),
      ).toBe(false);
      expect(
        within(screen.getByRole("navigation")).queryByRole("button", {
          name: "Administración",
        }) !== null,
      ).toBe(platform);
      semantics();
    },
  );
});
