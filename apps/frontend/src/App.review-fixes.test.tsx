import { NO_PERMISSIONS } from "./test/transport";
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

const organization = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia",
  slug: "academy",
};
const GROUP_B = "00000000-0000-4000-a000-000000000066";
const INVOICE_A = "00000000-0000-4000-8000-0000000000a1";
const INVOICE_B = "00000000-0000-4000-8000-0000000000b2";
const profile = {
  id: "user-A",
  name: "Persona A",
  rut: "12345678-5",
  email: null,
  username: null,
  isPlatformAdministrator: false,
  // «Facturas» is offered to people who can read invoices.
  memberships: [
    {
      organization,
      role: "USER",
      permissions: { ...NO_PERMISSIONS, readInvoices: true },
      groups: [
        {
          group: { id: GROUP_B, name: "Grupo B" },
          permissions: NO_PERMISSIONS,
          effective: { ...NO_PERMISSIONS, readInvoices: true },
        },
      ],
    },
  ],
};
const groups = [
  {
    id: "00000000-0000-4000-a000-000000000066",
    name: "Grupo B",
    description: null,
    organization,
    members: [],
  },
];
const businessIds: Record<string, string> = {
  [INVOICE_A]: "INV-A",
  [INVOICE_B]: "INV-B",
};
const invoice = (id: string) => ({
  id,
  businessId: businessIds[id],
  organizationId: organization.id,
  groupId: null,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  processingStatus: "NOT_REQUESTED",
  createdByUserId: "00000000-0000-4000-8000-000000000001",
  supplierName: `Proveedor ${id}`,
  amountPesos: 10000,
  businessStatus: "PENDING",
  createdAt: "2026-10-21",
});
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
      if (url.pathname === "/api/v1/invoices")
        return json({
          items: [invoice(INVOICE_A), invoice(INVOICE_B)],
          page: 1,
          pageSize: 20,
          total: 2,
        });
      if (/^\/api\/v1\/invoices\/[0-9a-f-]{36}$/.test(url.pathname))
        return json({ invoice: invoice(url.pathname.split("/")[4]) });
      throw new Error(`Unexpected read ${url.pathname}`);
    });
  const unexpected: string[] = [];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(input.toString(), "http://test.invalid");
      if (url.pathname === "/api/v1/auth/profile")
        return json({
          profile: {
            ...profile,
            id: `user-${identity}`,
            name: `Persona ${identity}`,
          },
        });
      if (url.pathname === "/api/v1/groups") return json({ groups });
      if (url.pathname === "/api/v1/auth/logout")
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/v1/auth/login") {
        identity = "B";
        return json({ user: { id: "user-B" } });
      }
      try {
        return await read(url);
      } catch (error) {
        unexpected.push(url.pathname);
        throw error;
      }
    });
  return { read, fetchMock, unexpected };
}
function navigate(name: string) {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", { name }),
  );
}
async function start(destination: string) {
  render(<App />);
  await screen.findByRole("navigation");
  navigate(destination);
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

const DETAIL = `/api/v1/invoices/${INVOICE_A}`;

describe("APP12 S1 CR003-008 regressions", () => {
  it("CR003 retains selector keyboard focus in Facturas without stale context data", async () => {
    const api = http();
    await start("Facturas");
    const selector = await screen.findByRole("combobox", {
      name: "Ver facturas de",
    });
    selector.focus();
    fireEvent.change(selector, {
      target: { value: `group:${organization.id}:${GROUP_B}` },
    });
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Ver facturas de" }),
    );
    await waitFor(() =>
      expect(
        api.read.mock.calls.some(
          ([url]) => url.searchParams.get("groupId") === GROUP_B,
        ),
      ).toBe(true),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", { name: "Ver facturas de" }),
    );
  });
  it.each(["/api/v1/invoices", DETAIL])(
    "CR007 expires the current session on protected GET %s 401",
    async (path) => {
      const api = http();
      const original = api.read.getMockImplementation()!;
      api.read.mockImplementation(async (url) =>
        url.pathname === path ? json({}, 401) : original(url),
      );
      await start("Facturas");
      if (path === DETAIL)
        fireEvent.click(await screen.findByRole("link", { name: "INV-A" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByRole("button", { name: "Salir" })).toBeNull();
    },
  );
  it.each(["/api/v1/invoices", DETAIL])(
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
      await start("Facturas");
      if (path === DETAIL)
        fireEvent.click(await screen.findByRole("link", { name: "INV-A" }));
      await waitFor(() => expect(intercepted).toBe(true));
      fireEvent.click(screen.getByRole("button", { name: "Salir" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      await loginB();
      await act(async () => pending.resolve(json({}, 401)));
      navigate("Mi perfil");
      expect(screen.getByText("Persona B")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
  it.each(["/api/v1/invoices", DETAIL])(
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
      await start("Facturas");
      if (path === DETAIL)
        fireEvent.click(await screen.findByRole("link", { name: "INV-A" }));
      await waitFor(() => expect(parse).toHaveBeenCalled());
      api.read.mockImplementation(async (url) =>
        url.pathname === "/api/v1/invoices" ? json({}, 401) : original(url),
      );
      navigate("Mi perfil");
      navigate("Facturas");
      await screen.findByRole("button", { name: "Iniciar sesión" });
      await loginB();
      await act(async () =>
        body.resolve(
          await (await original(new URL(path, "http://test.invalid"))).json(),
        ),
      );
      navigate("Mi perfil");
      expect(screen.getByText("Persona B")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});
