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
const createdAt = "2026-10-21T00:00:00Z";
const invoice: InvoiceDetail = {
  id: "S8-INVOICE",
  businessId: "S8-INVOICE",
  organizationId: "organization-1",
  groupId: "group-1",
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  processingStatus: "NOT_REQUESTED",
  createdByUserId: "user-1",
  supplierName: "Proveedor S8",
  amountPesos: 10000,
  businessStatus: "PENDING",
  createdAt,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function http({ platform = true, member = true, anonymous = false } = {}) {
  let authenticated = !anonymous;
  const profile: Profile = {
    id: id(2),
    name: "Persona S8",
    rut: "12345678-5",
    email: null,
    username: null,
    isPlatformAdministrator: platform,
    memberships: member ? [{ organization, role: "USER" }] : [],
  };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://test.invalid");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/v1/auth/profile" && method === "GET")
        return authenticated ? json({ profile }) : json({}, 401);
      if (url.pathname === "/api/v1/profile" && method === "PATCH") {
        Object.assign(profile, JSON.parse(String(init?.body)));
        return json({ profile });
      }
      if (url.pathname === "/api/v1/auth/signup") return json({}, 201);
      if (url.pathname === "/api/v1/auth/login") {
        authenticated = true;
        return json({});
      }
      if (url.pathname === "/api/v1/auth/logout") {
        authenticated = false;
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/v1/groups")
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
      if (url.pathname === "/api/v1/platform/organizations")
        return json({
          organizations: [
            { ...organization, groups: [] },
            { id: id(9), name: "Solo administración", groups: [] },
          ],
        });
      if (url.pathname === "/api/v1/business-policies" && method === "GET")
        return json({
          policies: [{ version: "s8-policy", manualReviewThreshold: 0.8 }],
        });
      if (url.pathname === "/api/v1/invoices" && method === "GET")
        return json({ invoices: [invoice], nextCursor: null });
      if (url.pathname === "/api/v1/invoices/S8-INVOICE" && method === "GET")
        return json({ invoice });
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
    ["Administración", "Membresías organizacionales"],
  ])(
    "mounts the real %s surface with Spanish landmarks and valid accessible references",
    async (destination, heading) => {
      const requests = http();
      render(<App />);
      await screen.findByText(/Bienvenido, Persona S8/);
      expect(
        requests.mock.calls.every(([input]) =>
          [
            "/api/v1/auth/profile",
            "/api/v1/groups",
            "/api/v1/platform/organizations",
          ].includes(String(input)),
        ),
      ).toBe(true);
      await navigate(destination);
      await screen.findByRole("heading", {
        level: 2,
        name: heading,
      });
      if (destination === "Panel principal") {
        const card = screen.getByRole("region", {
          name: "Tu espacio de trabajo",
        });
        expect(card.textContent).toContain("Academia S8");
        expect(card.textContent).toContain("Trabajo individual");
      } else {
        // Context details belong to the dashboard, not to a global banner.
        expect(
          screen.queryByRole("region", { name: "Tu espacio de trabajo" }),
        ).toBeNull();
        expect(screen.queryByText("Contexto de trabajo")).toBeNull();
        expect(screen.queryByLabelText("Contexto de trabajo")).toBeNull();
      }
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
    },
  );

  it("logs in only and establishes authority through the native profile read", async () => {
    const requests = http({ anonymous: true });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-s8-password" },
    });
    expect(screen.queryByRole("button", { name: "Crear cuenta" })).toBeNull();
    fireEvent.submit(screen.getByRole("form", { name: "Iniciar sesión" }));
    await screen.findByText(/Bienvenido, Persona S8/);
    expect(
      requests.mock.calls.filter(([input]) => input === "/api/v1/auth/profile"),
    ).toHaveLength(2);
    const login = requests.mock.calls.find(
      ([input]) => input === "/api/v1/auth/login",
    );
    expect(login?.[1]?.credentials).toBe("same-origin");
    expect(login?.[1]?.method).toBe("POST");
    expect(
      requests.mock.calls.some(([input]) => input === "/api/v1/auth/signup"),
    ).toBe(false);
    semantics();
  });

  it("carries a selected group from policies to the invoice detail", async () => {
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
    await screen.findByRole("heading", { name: "S8-INVOICE" });
    semantics();
    await navigate("Panel principal");
    expect(
      screen.getByRole("region", { name: "Tu espacio de trabajo" }).textContent,
    ).toContain("Grupo: Equipo S8");
    expect(
      requests.mock.calls.every(
        ([input, init]) =>
          String(input).startsWith("/") && init?.credentials === "same-origin",
      ),
    ).toBe(true);
    semantics();
  });

  it.each([false, true])(
    "does not turn platform discovery (%s) into domain access or regular student administration",
    async (platform) => {
      const requests = http({ platform, member: false });
      render(<App />);
      await screen.findByText(/Bienvenido, Persona S8/);
      expect(
        screen.getByRole("region", { name: "Tu espacio de trabajo" })
          .textContent,
      ).toContain("Elige una organización o grupo para empezar.");
      for (const destination of ["Facturas", "Políticas"]) {
        await navigate(destination);
        expect(screen.queryByLabelText("Propietario")).toBeNull();
      }
      expect(
        requests.mock.calls.some(([input]) =>
          /invoices|business-policies/.test(String(input)),
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
