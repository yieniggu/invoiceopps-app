import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import {
  groupInvoicesKey,
  invoiceKey,
  orgInvoicesKey,
} from "../auth/session/queryKeys";
import {
  compras,
  contabilidad,
  finanzas,
  groupReader,
  groupsOf,
  invoice,
  invoicePage,
  ME,
  norte,
  orgReader,
  queryOf,
  READ,
  sur,
} from "../../test/invoices";
import {
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
  type RouteHandler,
} from "../../test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LIST = "GET /api/v1/invoices";

const ORG_GROUPS = `GET /api/v1/organizations/${norte.id}/groups`;

/**
 * Transport for the inbox: the profile, the legacy catalogue, the list and the
 * groups of Norte (by default only the one the profile already lists).
 */
function inboxTransport(
  profile: () => Record<string, unknown>,
  list: RouteHandler,
  orgGroups: RouteHandler = () => groupsOf(contabilidad),
) {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: profile() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [LIST]: list,
    [ORG_GROUPS]: orgGroups,
  });
}

const optionValue = (name: string) =>
  (screen.getByRole("option", { name }) as HTMLOptionElement).value;

const selectContext = async (name: string) => {
  const selector = await screen.findByLabelText("Ver facturas de");
  fireEvent.change(selector, { target: { value: optionValue(name) } });
};

const search = () => new URLSearchParams(window.location.search);

describe("context selector (AC-14)", () => {
  it("offers the organization, the ungrouped scope and only the readable groups", async () => {
    inboxTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", {
              permissions: READ,
              groups: [
                { group: contabilidad, effective: READ },
                {
                  group: compras,
                  permissions: READ,
                  effective: { ...READ, readInvoices: false },
                },
              ],
            }),
          ],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/invoices" });
    const selector = await screen.findByLabelText("Ver facturas de");
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Toda la organización", "Sin grupo asignado", "Contabilidad"]);
  });

  it("offers only the group when the person reads just that group", async () => {
    inboxTransport(groupReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    const selector = await screen.findByLabelText("Ver facturas de");
    expect(
      within(selector)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Compras"]);
  });

  it("groups the options by organization when there are several organizations", async () => {
    inboxTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", { permissions: READ }),
            membership(sur, "USER", {
              groups: [{ group: compras, effective: READ }],
            }),
          ],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/invoices" });
    const selector = await screen.findByLabelText("Ver facturas de");
    expect(
      within(selector)
        .getAllByRole("group")
        .map((group) => [
          group.getAttribute("label"),
          within(group)
            .getAllByRole("option")
            .map((option) => option.textContent),
        ]),
    ).toEqual([
      ["Academia Norte", ["Toda la organización", "Sin grupo asignado"]],
      ["Instituto Sur", ["Compras"]],
    ]);
  });

  it("lists the whole organization by default, without a group filter", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    await screen.findByText(/Todavía no hay facturas/);
    expect(transport.calls(LIST)).toHaveLength(1);
    expect(queryOf(transport.calls(LIST)[0]!)).toEqual({
      organizationId: norte.id,
      page: "1",
      pageSize: "20",
    });
  });

  it("falls back to the first readable group when there is no organization read", async () => {
    const transport = inboxTransport(groupReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    await screen.findByText(/Todavía no hay facturas/);
    expect(queryOf(transport.calls(LIST)[0]!)).toEqual({
      organizationId: norte.id,
      groupId: compras.id,
      page: "1",
      pageSize: "20",
    });
  });

  it("explains the missing access and sends no invoice request without any readable option", async () => {
    const transport = inboxTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "ADMIN", {
              permissions: {
                ...READ,
                readInvoices: false,
                createInvoices: true,
              },
            }),
          ],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByText("Aún no puedes ver facturas")).toBeTruthy();
    expect(screen.queryByLabelText("Ver facturas de")).toBeNull();
    expect(transport.calls(LIST)).toHaveLength(0);
  });

  it("shows the same empty state to a platform administrator without memberships", async () => {
    const transport = inboxTransport(
      () => profileFixture({ isPlatformAdministrator: true }),
      () => invoicePage([]),
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByText("Aún no puedes ver facturas")).toBeTruthy();
    expect(transport.calls(LIST)).toHaveLength(0);
  });

  it("ignores a URL context the person cannot read and uses the default", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: `/invoices?organizationId=${sur.id}` });
    await screen.findByText(/Todavía no hay facturas/);
    expect(queryOf(transport.calls(LIST)[0]!).organizationId).toBe(norte.id);
  });

  it("controls are reachable by label and keyboard-operable native elements", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    for (const label of [
      "Ver facturas de",
      "Desde",
      "Hasta",
      "Buscar por número o proveedor",
    ])
      expect(screen.getByLabelText(label)).toBeTruthy();
    expect(
      screen.getByRole("radiogroup", { name: "Estado de la factura" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buscar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "FAC-1" })).toBeTruthy();
  });
});

describe("requests, URL state and page reset (AC-15)", () => {
  it("requests the group and writes the context to the URL", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    await screen.findByText(/Todavía no hay facturas/);
    await selectContext("Contabilidad");
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
      page: "1",
      pageSize: "20",
    });
    expect(search().get("groupId")).toBe(contabilidad.id);
    expect(search().get("organizationId")).toBe(norte.id);
  });

  it("requests ungrouped=true, never together with a group", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    await screen.findByText(/Todavía no hay facturas/);
    await selectContext("Sin grupo asignado");
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!)).toEqual({
      organizationId: norte.id,
      ungrouped: "true",
      page: "1",
      pageSize: "20",
    });
    expect(search().get("ungrouped")).toBe("true");
    expect(search().has("groupId")).toBe(false);
  });

  it("restores context, filters and page from the URL", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)], { page: 2, total: 41 }),
    );
    renderApp({
      route: `/invoices?organizationId=${norte.id}&groupId=${contabilidad.id}&businessStatus=APPROVED&issuedFrom=2026-01-01&issuedTo=2026-02-01&q=acme&page=2`,
    });
    await screen.findByRole("table", { name: "Facturas" });
    expect(queryOf(transport.calls(LIST)[0]!)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
      businessStatus: "APPROVED",
      issuedFrom: "2026-01-01",
      issuedTo: "2026-02-01",
      q: "acme",
      page: "2",
      pageSize: "20",
    });
    expect(
      (screen.getByLabelText("Ver facturas de") as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe("Contabilidad");
    expect(
      (screen.getByRole("radio", { name: "Aprobadas" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe(
      "2026-01-01",
    );
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe(
      "2026-02-01",
    );
    expect(
      (
        screen.getByLabelText(
          "Buscar por número o proveedor",
        ) as HTMLInputElement
      ).value,
    ).toBe("acme");
  });

  it("goes to the next page through the URL", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)], { total: 41 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!).page).toBe("2");
    expect(search().get("page")).toBe("2");
  });

  it.each([
    [
      "status",
      () => fireEvent.click(screen.getByRole("radio", { name: "Rechazadas" })),
      { businessStatus: "REJECTED" },
    ],
    [
      "issuedFrom",
      () =>
        fireEvent.change(screen.getByLabelText("Desde"), {
          target: { value: "2026-03-01" },
        }),
      { issuedFrom: "2026-03-01" },
    ],
    [
      "issuedTo",
      () =>
        fireEvent.change(screen.getByLabelText("Hasta"), {
          target: { value: "2026-04-01" },
        }),
      { issuedTo: "2026-04-01" },
    ],
    [
      "text",
      () => {
        fireEvent.change(
          screen.getByLabelText("Buscar por número o proveedor"),
          {
            target: { value: "  acme  " },
          },
        );
        fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
      },
      { q: "acme" },
    ],
    [
      "context",
      () =>
        fireEvent.change(screen.getByLabelText("Ver facturas de"), {
          target: { value: optionValue("Sin grupo asignado") },
        }),
      { ungrouped: "true" },
    ],
  ])("a %s change resets the page to 1", async (_name, change, expected) => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)], { page: 3, total: 100 }),
    );
    renderApp({ route: `/invoices?organizationId=${norte.id}&page=3` });
    await screen.findByRole("table", { name: "Facturas" });
    expect(queryOf(transport.calls(LIST)[0]!).page).toBe("3");
    change();
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!)).toMatchObject({
      ...expected,
      page: "1",
    });
    expect(search().has("page")).toBe(false);
  });

  it("does not send an inverted date range and says why", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({
      route: `/invoices?organizationId=${norte.id}&issuedFrom=2026-05-01&issuedTo=2026-04-01`,
    });
    expect(
      await screen.findByText(
        "La fecha «Desde» no puede ser posterior a «Hasta».",
      ),
    ).toBeTruthy();
    expect(transport.calls(LIST)).toHaveLength(0);
  });

  it("moves to the last page that exists when the URL page is past the end", async () => {
    const transport = inboxTransport(orgReader, ({ search: query }) => {
      const page = Number(new URLSearchParams(query).get("page"));
      return page === 1
        ? invoicePage([invoice(1)], { total: 1 })
        : invoicePage([], { page, total: 1 });
    });
    renderApp({ route: `/invoices?organizationId=${norte.id}&page=9` });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(search().has("page")).toBe(false);
    expect(transport.calls(LIST).map((call) => queryOf(call).page)).toEqual([
      "9",
      "1",
    ]);
  });

  it("keeps the remote state in Query under the documented keys", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    const { store } = renderApp({
      route: `/invoices?organizationId=${norte.id}&ungrouped=true`,
    });
    await screen.findByRole("table", { name: "Facturas" });
    const keys = store
      .getSnapshot()
      .client.getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toContainEqual([
      "identity",
      ME,
      "org",
      norte.id,
      "invoices",
      { ungrouped: true, page: 1, pageSize: 20 },
    ]);
    await selectContext("Contabilidad");
    await waitFor(() =>
      expect(
        store
          .getSnapshot()
          .client.getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toContainEqual([
        "identity",
        ME,
        "org",
        norte.id,
        "group",
        contabilidad.id,
        "invoices",
        { page: 1, pageSize: 20 },
      ]),
    );
  });
});

describe("no data from another context (AC-15)", () => {
  it("never renders the late answer of context A under context B", async () => {
    const lateA = deferred<Response>();
    const transport = inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("groupId")
        ? invoicePage([invoice(2, { groupId: contabilidad.id })])
        : lateA.promise,
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByText("Cargando facturas…")).toBeTruthy();
    await selectContext("Contabilidad");
    expect(await screen.findByRole("link", { name: "FAC-2" })).toBeTruthy();
    await act(async () => {
      lateA.resolve(invoicePage([invoice(1)]));
      await Promise.resolve();
    });
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(screen.getByRole("link", { name: "FAC-2" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
  });

  it("shows loading, not the previous context's rows, while the next context loads", async () => {
    const pendingB = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("groupId")
        ? pendingB.promise
        : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    await selectContext("Contabilidad");
    expect(await screen.findByText("Cargando facturas…")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
    pendingB.resolve(invoicePage([]));
    expect(await screen.findByText(/Todavía no hay facturas/)).toBeTruthy();
  });
});

describe("states (AC-16)", () => {
  it("announces loading as a status", async () => {
    const pending = deferred<Response>();
    inboxTransport(orgReader, () => pending.promise);
    renderApp({ route: "/invoices" });
    expect(
      (await screen.findByText("Cargando facturas…")).getAttribute("role"),
    ).toBe("status");
    pending.resolve(invoicePage([]));
    await screen.findByText(/Todavía no hay facturas/);
  });

  it("shows an alert with «Reintentar» and recovers", async () => {
    let fail = true;
    const transport = inboxTransport(orgReader, () =>
      fail ? errorResponse(500, "INTERNAL") : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("No fue posible cargar las facturas.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(transport.calls(LIST)).toHaveLength(2);
  });

  it("«Actualizar» refetches and shows invoices created meanwhile", async () => {
    let rows = [invoice(1)];
    const transport = inboxTransport(orgReader, () => invoicePage(rows));
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    rows = [invoice(2), invoice(1)];
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(await screen.findByRole("link", { name: "FAC-2" })).toBeTruthy();
    expect(transport.calls(LIST)).toHaveLength(2);
  });

  it("keeps the rows and warns when a refresh fails", async () => {
    let fail = false;
    inboxTransport(orgReader, () =>
      fail ? errorResponse(500, "INTERNAL") : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "puede estar desactualizado",
    );
    expect(screen.getByRole("link", { name: "FAC-1" })).toBeTruthy();
  });

  it("renders each row with business data, CLP pesos and Spanish statuses", async () => {
    inboxTransport(orgReader, () =>
      invoicePage([
        invoice(1),
        invoice(2, {
          groupId: contabilidad.id,
          amountPesos: 1234567,
          businessStatus: "APPROVED",
          issuedOn: "2026-01-02",
          dueOn: "2026-02-03",
        }),
      ]),
    );
    renderApp({ route: "/invoices" });
    const table = await screen.findByRole("table", { name: "Facturas" });
    const [, ungrouped, grouped] = within(table).getAllByRole("row");
    const cells = (row: HTMLElement | undefined) =>
      within(row!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent?.replace(/\s/g, " "));
    expect(cells(ungrouped)).toEqual([
      "FAC-1",
      "Proveedor 1",
      "Sin grupo",
      "25-10-2026",
      "31-12-2099",
      "Pendiente",
      "$12.500",
    ]);
    expect(cells(grouped)).toEqual([
      "FAC-2",
      "Proveedor 2",
      "Contabilidad",
      "02-01-2026",
      "03-02-2026",
      "Aprobada",
      "$1.234.567",
    ]);
    // Technical values are never the main content, and the processing status
    // is not passed off as the business status.
    const text = table.textContent ?? "";
    expect(text).not.toContain("NOT_REQUESTED");
    expect(text).not.toContain("Sin procesamiento");
    expect(text).not.toContain(invoice(1).id);
    expect(text).not.toContain("PENDING");
  });

  it("links each row to its detail with the organization and the group of the invoice", async () => {
    inboxTransport(orgReader, () =>
      invoicePage([invoice(1), invoice(2, { groupId: contabilidad.id })]),
    );
    renderApp({ route: "/invoices" });
    const plain = await screen.findByRole("link", { name: "FAC-1" });
    const grouped = screen.getByRole("link", { name: "FAC-2" });
    const plainUrl = new URL(plain.getAttribute("href")!, "http://x");
    expect(plainUrl.pathname).toBe(`/invoices/${invoice(1).id}`);
    expect(Object.fromEntries(plainUrl.searchParams)).toEqual({
      organizationId: norte.id,
    });
    const groupedUrl = new URL(grouped.getAttribute("href")!, "http://x");
    expect(groupedUrl.pathname).toBe(`/invoices/${invoice(2).id}`);
    expect(Object.fromEntries(groupedUrl.searchParams)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
    });
  });
});

describe("revoked access (AC-17)", () => {
  it("a 403 removes the rows, refreshes the profile and drops the context", async () => {
    let revoked = false;
    const transport = inboxTransport(
      () => (revoked ? profileFixture() : orgReader()),
      () => {
        if (!revoked) return invoicePage([invoice(1)]);
        return errorResponse(403, "FORBIDDEN");
      },
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const profileCalls = transport.calls("GET /api/v1/auth/profile").length;
    revoked = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull(),
    );
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/auth/profile").length,
      ).toBeGreaterThan(profileCalls),
    );
    expect(await screen.findByText("Aún no puedes ver facturas")).toBeTruthy();
    expect(screen.queryByLabelText("Ver facturas de")).toBeNull();
  });

  it("a 403 that the profile does not confirm still hides the rows and does not loop", async () => {
    let denied = false;
    const transport = inboxTransport(orgReader, () =>
      denied ? errorResponse(403, "FORBIDDEN") : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(
      await screen.findByText(/Ya no tienes permiso para ver estas facturas/),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
    // Terminal state: the profile answered once more and nothing re-armed the
    // list, so the request count is settled.
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
    expect(transport.calls(LIST)).toHaveLength(2);
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2);
  });

  it("a 401 uses the existing unauthorized flow", async () => {
    let expired = false;
    inboxTransport(orgReader, () =>
      expired
        ? errorResponse(401, "UNAUTHENTICATED")
        : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    expired = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(
      await screen.findByRole("heading", { name: "Iniciar sesión" }),
    ).toBeTruthy();
  });
});

describe("navigation entry (AC-18)", () => {
  const navLink = () =>
    screen
      .getByRole("navigation", { name: "Navegación principal" })
      .querySelector('a[href="/invoices"]');

  it.each([
    ["organization read", { ...READ }],
    [
      "organization create only",
      { ...READ, readInvoices: false, createInvoices: true },
    ],
    [
      "organization delete own only",
      { ...READ, readInvoices: false, deleteOwnInvoices: true },
    ],
    [
      "organization delete others only",
      { ...READ, readInvoices: false, deleteOthersInvoices: true },
    ],
  ])("shows «Facturas» with %s", async (_name, permissions) => {
    inboxTransport(
      () =>
        profileFixture({
          memberships: [membership(norte, "USER", { permissions })],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/profile" });
    await screen.findByRole("link", { name: "Facturas" });
    expect(navLink()).not.toBeNull();
  });

  it("shows «Facturas» when only a group grants an effective flag", async () => {
    inboxTransport(groupReader, () => invoicePage([]));
    renderApp({ route: "/profile" });
    expect(await screen.findByRole("link", { name: "Facturas" })).toBeTruthy();
  });

  it("hides «Facturas» for an organization ADMIN without invoice flags and for a platform administrator", async () => {
    inboxTransport(
      () =>
        profileFixture({
          isPlatformAdministrator: true,
          memberships: [membership(norte, "ADMIN")],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/profile" });
    await screen.findByRole("heading", { level: 1, name: "Mi perfil" });
    expect(navLink()).toBeNull();
    expect(screen.queryByRole("link", { name: /Tokens API/ })).toBeNull();
  });

  it("leaves the other entries untouched", async () => {
    inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: "/profile" });
    await screen.findByRole("link", { name: "Facturas" });
    for (const name of [
      "Panel principal",
      "Organizaciones",
      "Grupos",
      "Mi perfil",
    ])
      expect(screen.getByRole("link", { name })).toBeTruthy();
  });
});

describe("groups of an organization-wide reader (groupName variance)", () => {
  const optionLabels = () =>
    within(screen.getByLabelText("Ver facturas de"))
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("offers a group the person is not a member of once the groups query answers", async () => {
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([]),
      () => groupsOf(contabilidad, finanzas),
    );
    renderApp({ route: "/invoices" });
    await waitFor(() =>
      expect(optionLabels()).toEqual([
        "Toda la organización",
        "Sin grupo asignado",
        "Contabilidad",
        "Finanzas",
      ]),
    );
    expect(transport.calls(ORG_GROUPS)).toHaveLength(1);

    await selectContext("Finanzas");
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!).groupId).toBe(finanzas.id);
  });

  it("offers the organization, the ungrouped scope and the profile groups while the groups query loads", async () => {
    const pending = deferred<Response>();
    inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => pending.promise,
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(optionLabels()).toEqual([
      "Toda la organización",
      "Sin grupo asignado",
      "Contabilidad",
    ]);
    pending.resolve(groupsOf(contabilidad, finanzas));
    await waitFor(() => expect(optionLabels()).toContain("Finanzas"));
    expect(screen.getByRole("link", { name: "FAC-1" })).toBeTruthy();
  });

  it("keeps the profile options and offers a non-blocking «Reintentar» when the groups query fails", async () => {
    let failing = true;
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () =>
        failing
          ? errorResponse(500, "INTERNAL")
          : groupsOf(contabilidad, finanzas),
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    const notice = await screen.findByText(
      "No fue posible cargar todos los grupos de tu organización. Solo ves los que ya conocemos.",
    );
    expect(notice.closest("[role]")?.getAttribute("role")).toBe("status");
    expect(transport.calls(ORG_GROUPS).length).toBe(1);
    expect(optionLabels()).toEqual([
      "Toda la organización",
      "Sin grupo asignado",
      "Contabilidad",
    ]);
    // The inbox stays usable: the failure is not an alert.
    expect(screen.queryByRole("alert")).toBeNull();
    failing = false;
    fireEvent.click(
      within(notice.closest("[role]") as HTMLElement).getByRole("button", {
        name: "Reintentar",
      }),
    );
    await waitFor(() => expect(optionLabels()).toContain("Finanzas"));
    expect(transport.calls(ORG_GROUPS)).toHaveLength(2);
    expect(
      screen.queryByText(/No fue posible cargar todos los grupos/),
    ).toBeNull();
  });

  it("does not ask for the organization's groups again within a minute of leaving and coming back", async () => {
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => groupsOf(contabilidad, finanzas),
    );
    renderApp({ route: "/invoices" });
    await waitFor(() => expect(optionLabels()).toContain("Finanzas"));
    fireEvent.click(screen.getByRole("link", { name: "Mi perfil" }));
    await screen.findByRole("heading", { level: 1, name: "Mi perfil" });
    fireEvent.click(screen.getByRole("link", { name: "Facturas" }));
    await screen.findByRole("link", { name: "FAC-1" });
    expect(transport.calls(ORG_GROUPS)).toHaveLength(1);
  });

  it("waits for the groups query before honouring a URL group of a non-member group, then lists it without rewriting the URL", async () => {
    const pending = deferred<Response>();
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([invoice(5, { groupId: finanzas.id })]),
      () => pending.promise,
    );
    const route = `/invoices?organizationId=${norte.id}&groupId=${finanzas.id}`;
    renderApp({ route });
    expect(await screen.findByText("Cargando facturas…")).toBeTruthy();
    expect(transport.calls(LIST)).toHaveLength(0);
    expect(search().get("groupId")).toBe(finanzas.id);

    pending.resolve(groupsOf(contabilidad, finanzas));
    expect(await screen.findByRole("link", { name: "FAC-5" })).toBeTruthy();
    expect(transport.calls(LIST)).toHaveLength(1);
    expect(queryOf(transport.calls(LIST)[0]!).groupId).toBe(finanzas.id);
    expect(search().get("groupId")).toBe(finanzas.id);
    expect(
      (screen.getByLabelText("Ver facturas de") as HTMLSelectElement)
        .selectedOptions[0]?.textContent,
    ).toBe("Finanzas");
  });

  it("falls back to the default context, keeping the URL, when the groups query fails for a non-member group", async () => {
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => errorResponse(500, "INTERNAL"),
    );
    renderApp({
      route: `/invoices?organizationId=${norte.id}&groupId=${finanzas.id}`,
    });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(queryOf(transport.calls(LIST)[0]!).groupId).toBeUndefined();
    expect(search().get("groupId")).toBe(finanzas.id);
  });

  it("falls back to the default when the groups query does not list the URL group", async () => {
    const transport = inboxTransport(orgReader, () => invoicePage([]));
    renderApp({
      route: `/invoices?organizationId=${norte.id}&groupId=${finanzas.id}`,
    });
    await screen.findByText(/Todavía no hay facturas/);
    expect(queryOf(transport.calls(LIST)[0]!).groupId).toBeUndefined();
  });

  it("shows the real group name of every row, including a group the person is not in", async () => {
    inboxTransport(
      orgReader,
      () =>
        invoicePage([
          invoice(1),
          invoice(2, { groupId: contabilidad.id }),
          invoice(3, { groupId: finanzas.id }),
        ]),
      () => groupsOf(contabilidad, finanzas),
    );
    renderApp({ route: "/invoices" });
    const table = await screen.findByRole("table", { name: "Facturas" });
    const cells = (name: string) =>
      within(within(table).getByRole("link", { name }).closest("tr")!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells("FAC-1")[2]).toBe("Sin grupo");
    expect(cells("FAC-2")[2]).toBe("Contabilidad");
    expect(cells("FAC-3")[2]).toBe("Finanzas");
    expect(document.body.textContent).not.toContain("Otro grupo");
  });

  it("asks for no groups and offers only profile groups to a group-only reader", async () => {
    const transport = inboxTransport(groupReader, () =>
      invoicePage([invoice(1, { groupId: compras.id })]),
    );
    renderApp({ route: "/invoices" });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(optionLabels()).toEqual(["Compras"]);
    expect(transport.calls(ORG_GROUPS)).toHaveLength(0);
    expect(transport.unexpected).toEqual([]);
  });
});

describe("header, toolbar and states of the redesigned inbox", () => {
  const FILTERED = `/invoices?organizationId=${norte.id}&groupId=${contabilidad.id}&businessStatus=APPROVED&issuedFrom=2026-01-01&issuedTo=2026-02-01&q=acme&page=3`;

  it("names the selected scope in words under the title", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    expect(
      screen.getByText("Toda la organización · Academia Norte"),
    ).toBeTruthy();
    await selectContext("Contabilidad");
    expect(
      await screen.findByText("Grupo Contabilidad · Academia Norte"),
    ).toBeTruthy();
  });

  it.each([
    [1, "1 factura"],
    [57, "57 facturas"],
  ])("counts %i results as «%s»", async (total, text) => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)], { total }));
    renderApp({ route: "/invoices" });
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("says which rows of the total the page shows", async () => {
    inboxTransport(orgReader, () =>
      invoicePage([invoice(21), invoice(22)], { page: 2, total: 22 }),
    );
    renderApp({ route: `/invoices?organizationId=${norte.id}&page=2` });
    expect(await screen.findByText("Mostrando 21–22 de 22")).toBeTruthy();
  });

  it("marks the refresh as busy while it fetches", async () => {
    let rows = [invoice(1)];
    const slow = deferred<Response>();
    let hold = false;
    inboxTransport(orgReader, () => (hold ? slow.promise : invoicePage(rows)));
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    expect(
      screen
        .getByRole("button", { name: "Actualizar" })
        .getAttribute("aria-busy"),
    ).toBe("false");
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Actualizar" })
          .getAttribute("aria-busy"),
      ).toBe("true"),
    );
    rows = [];
    slow.resolve(invoicePage([invoice(1)]));
  });

  it("shows «Limpiar filtros» only while a filter is active", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    expect(
      screen.queryByRole("button", { name: "Limpiar filtros" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Pendientes" }));
    expect(
      await screen.findByRole("button", { name: "Limpiar filtros" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Todas" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Limpiar filtros" }),
      ).toBeNull(),
    );
  });

  it("«Limpiar filtros» resets the filters and the page and keeps the scope", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)], { page: 3, total: 100 }),
    );
    renderApp({ route: FILTERED });
    await screen.findByRole("table", { name: "Facturas" });
    fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
      page: "1",
      pageSize: "20",
    });
    expect([...search().keys()].sort()).toEqual(["groupId", "organizationId"]);
    expect(search().get("groupId")).toBe(contabilidad.id);
    expect(
      screen.queryByRole("button", { name: "Limpiar filtros" }),
    ).toBeNull();
    expect(
      (screen.getByRole("radio", { name: "Todas" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("status chips write businessStatus to the URL and are keyboard-operable radios", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    const group = screen.getByRole("radiogroup", {
      name: "Estado de la factura",
    });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.parentElement?.textContent),
    ).toEqual(["Todas", "Pendientes", "Aprobadas", "Rechazadas", "Canceladas"]);
    for (const [name, status] of [
      ["Pendientes", "PENDING"],
      ["Aprobadas", "APPROVED"],
      ["Rechazadas", "REJECTED"],
      ["Canceladas", "CANCELLED"],
    ] as const) {
      fireEvent.click(screen.getByRole("radio", { name }));
      await waitFor(() => expect(search().get("businessStatus")).toBe(status));
      expect(
        (screen.getByRole("radio", { name }) as HTMLInputElement).checked,
      ).toBe(true);
    }
    fireEvent.click(screen.getByRole("radio", { name: "Todas" }));
    await waitFor(() => expect(search().has("businessStatus")).toBe(false));
  });

  it("clears the search box with its «x» and searches for nothing", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: `/invoices?organizationId=${norte.id}&q=acme` });
    await screen.findByRole("table", { name: "Facturas" });
    fireEvent.click(screen.getByRole("button", { name: "Borrar búsqueda" }));
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!).q).toBeUndefined();
    expect(search().has("q")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Borrar búsqueda" }),
    ).toBeNull();
  });

  it("flags only past-due PENDING invoices as «Vencida»", async () => {
    inboxTransport(orgReader, () =>
      invoicePage([
        invoice(1, { dueOn: "2020-01-01" }),
        invoice(2, { dueOn: "2020-01-01", businessStatus: "APPROVED" }),
        invoice(3, { dueOn: "2099-01-01" }),
      ]),
    );
    renderApp({ route: "/invoices" });
    const table = await screen.findByRole("table", { name: "Facturas" });
    const rowOf = (name: string) =>
      within(table).getByRole("link", { name }).closest("tr") as HTMLElement;
    expect(within(rowOf("FAC-1")).getByText("Vencida")).toBeTruthy();
    expect(within(rowOf("FAC-2")).queryByText("Vencida")).toBeNull();
    expect(within(rowOf("FAC-3")).queryByText("Vencida")).toBeNull();
  });

  it("shows a plain empty state, without «Limpiar filtros», when the scope has no invoices", async () => {
    inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: "/invoices" });
    expect(
      await screen.findByRole("heading", {
        name: "Todavía no hay facturas en Academia Norte",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Limpiar filtros" }),
    ).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("offers «Limpiar filtros» in the empty state when the filters match nothing", async () => {
    inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: `/invoices?organizationId=${norte.id}&q=zzz` });
    expect(
      await screen.findByRole("heading", {
        name: "Ninguna factura coincide con los filtros",
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/Todavía no hay facturas/)).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "Limpiar filtros" });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(
      await screen.findByRole("heading", {
        name: "Todavía no hay facturas en Academia Norte",
      }),
    ).toBeTruthy();
    expect(search().has("q")).toBe(false);
  });

  it("shows five placeholder rows behind a busy region while loading", async () => {
    const pending = deferred<Response>();
    inboxTransport(orgReader, () => pending.promise);
    const { container } = renderApp({ route: "/invoices" });
    const status = await screen.findByText("Cargando facturas…");
    expect(status.getAttribute("role")).toBe("status");
    // The status region is persistent; the busy region holds the placeholders.
    expect(status.closest("[aria-busy]")).toBeNull();
    const rows = container.querySelectorAll(".invoice-skeleton-row");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    pending.resolve(invoicePage([]));
    await screen.findByText(/Todavía no hay facturas/);
  });

  it("never renders the word «contexto» in the inbox", async () => {
    inboxTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", { permissions: READ }),
            membership(sur, "USER", {
              groups: [{ group: compras, effective: READ }],
            }),
          ],
        }),
      () => invoicePage([]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByText(/Todavía no hay facturas/);
    expect(document.body.textContent).not.toMatch(/contexto/i);
    expect(document.body.innerHTML).not.toMatch(/contexto/i);
  });
});

describe("page and filter changes inside one scope (CR-350)", () => {
  const pageOf = (query: string) =>
    Number(new URLSearchParams(query).get("page") ?? 1);
  const table = () => screen.getByRole("table", { name: "Facturas" });

  it("keeps the footer, its focus and the previous rows (busy) while the next page loads", async () => {
    const next = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : next.promise,
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const button = screen.getByRole("button", { name: "Siguiente" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(search().get("page")).toBe("2"));
    expect(screen.getByRole("button", { name: "Siguiente" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(table().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("link", { name: "FAC-1" })).toBeTruthy();
    await act(async () => {
      next.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("link", { name: "FAC-21" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Siguiente" })).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(table().getAttribute("aria-busy")).toBeNull();
  });

  it("does not move to a second page when «Siguiente» is clicked again while the first change loads", async () => {
    const next = deferred<Response>();
    const transport = inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 100 })
        : next.promise,
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const button = screen.getByRole("button", { name: "Siguiente" });
    fireEvent.click(button);
    await waitFor(() => expect(search().get("page")).toBe("2"));
    fireEvent.click(button);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(search().get("page")).toBe("2");
    await act(async () => {
      next.resolve(invoicePage([invoice(21)], { page: 2, total: 100 }));
      await Promise.resolve();
    });
    await screen.findByRole("link", { name: "FAC-21" });
    expect(transport.calls(LIST)).toHaveLength(2);
  });

  it("keeps the previous rows, busy, while a filter of the same scope loads", async () => {
    const next = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("businessStatus")
        ? next.promise
        : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("radio", { name: "Pendientes" }));
    await waitFor(() => expect(search().get("businessStatus")).toBe("PENDING"));
    expect(screen.getByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(table().getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      next.resolve(invoicePage([invoice(2)]));
      await Promise.resolve();
    });
    expect(await screen.findByRole("link", { name: "FAC-2" })).toBeTruthy();
  });

  it("never keeps rows across the organization and ungrouped scopes", async () => {
    const pending = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("ungrouped")
        ? pending.promise
        : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    await selectContext("Sin grupo asignado");
    expect(await screen.findByText("Cargando facturas…")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
    pending.resolve(invoicePage([]));
    await screen.findByText(/Todavía no hay facturas/);
  });

  it("shows no empty state while the previous (empty) filtered page is only a placeholder", async () => {
    const next = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("q") ? invoicePage([]) : next.promise,
    );
    renderApp({ route: `/invoices?organizationId=${norte.id}&q=zzz` });
    await screen.findByRole("heading", {
      name: "Ninguna factura coincide con los filtros",
    });
    const buttons = screen.getAllByRole("button", { name: "Limpiar filtros" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(search().has("q")).toBe(false));
    expect(
      screen.queryByRole("heading", {
        name: /Ninguna factura coincide|Todavía no hay facturas/,
      }),
    ).toBeNull();
    await act(async () => {
      next.resolve(invoicePage([invoice(1)]));
      await Promise.resolve();
    });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
  });

  it("shows the alert with «Reintentar» when a page fails and recovers", async () => {
    let fail = true;
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : fail
          ? errorResponse(500, "INTERNAL")
          : invoicePage([invoice(21)], { page: 2, total: 41 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar las facturas.",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("link", { name: "FAC-21" })).toBeTruthy();
  });

  it("still redirects to the last page when the answer for the URL page is empty", async () => {
    const transport = inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 1 })
        : invoicePage([], { page: pageOf(query), total: 1 }),
    );
    renderApp({ route: `/invoices?organizationId=${norte.id}&page=1` });
    await screen.findByRole("link", { name: "FAC-1" });
    window.history.pushState(
      null,
      "",
      `/invoices?organizationId=${norte.id}&page=9`,
    );
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(search().has("page")).toBe(false));
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(transport.calls(LIST).map((call) => queryOf(call).page)).toContain(
      "9",
    );
  });
});

describe("«Actualizar» keeps keyboard focus (CR-351)", () => {
  it("stays focused, announces busy through aria-disabled and ignores a second activation", async () => {
    const slow = deferred<Response>();
    let hold = false;
    const transport = inboxTransport(orgReader, () =>
      hold ? slow.promise : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const refresh = screen.getByRole("button", { name: "Actualizar" });
    refresh.focus();
    hold = true;
    fireEvent.click(refresh);
    await waitFor(() => expect(refresh.getAttribute("aria-busy")).toBe("true"));
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    fireEvent.click(refresh);
    expect(transport.calls(LIST)).toHaveLength(2);
    await act(async () => {
      slow.resolve(invoicePage([invoice(1)]));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(refresh.getAttribute("aria-busy")).toBe("false"),
    );
    expect(refresh.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(refresh);
  });
});

describe("a 403 drops restricted cache entries (CR-355)", () => {
  it("removes the organization's cached details and other lists, but not another organization's", async () => {
    let denied = false;
    const transport = inboxTransport(orgReader, () =>
      denied ? errorResponse(403, "FORBIDDEN") : invoicePage([invoice(1)]),
    );
    const { store } = renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const client = store.getSnapshot().client;
    const detailOfNorte = invoiceKey(ME, norte.id, invoice(5).id);
    const detailOfSur = invoiceKey(ME, sur.id, invoice(6).id);
    const otherListOfNorte = orgInvoicesKey(ME, norte.id, { seed: 1 });
    const groupListOfNorte = groupInvoicesKey(ME, norte.id, compras.id, {
      seed: 1,
    });
    for (const key of [
      detailOfNorte,
      detailOfSur,
      otherListOfNorte,
      groupListOfNorte,
    ])
      client.setQueryData(key, { seeded: true });
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findByText(/Ya no tienes permiso para ver estas facturas/);
    expect(client.getQueryState(detailOfNorte)).toBeUndefined();
    expect(client.getQueryState(otherListOfNorte)).toBeUndefined();
    expect(client.getQueryState(detailOfSur)).toBeDefined();
    expect(client.getQueryState(groupListOfNorte)).toBeDefined();
    expect(transport.calls(LIST)).toHaveLength(2);
  });

  it("re-entering a detail cached before the 403 never flashes its data", async () => {
    const found = invoice(3);
    let denied = false;
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: orgReader() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [LIST]: () =>
        denied ? errorResponse(403, "FORBIDDEN") : invoicePage([found]),
      [`GET /api/v1/invoices/${found.id}`]: () =>
        denied
          ? errorResponse(403, "FORBIDDEN")
          : jsonResponse({ invoice: found }),
      [ORG_GROUPS]: () => groupsOf(contabilidad),
    });
    renderApp({ route: "/invoices" });
    fireEvent.click(await screen.findByRole("link", { name: "FAC-3" }));
    await screen.findByRole("heading", { level: 1, name: "FAC-3" });
    await act(async () => window.history.back());
    await screen.findByRole("table", { name: "Facturas" });
    // The inbox revalidates on return; refresh once that settled.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Actualizar" })
          .getAttribute("aria-busy"),
      ).toBe("false"),
    );
    denied = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await screen.findByText(/Ya no tienes permiso para ver estas facturas/);
    await act(async () => window.history.forward());
    // The first paint of the detail has nothing of the restricted invoice.
    expect(screen.queryByText("Proveedor 3")).toBeNull();
    expect(
      screen.queryByRole("heading", { level: 1, name: "FAC-3" }),
    ).toBeNull();
    expect(
      await screen.findByText("No tienes permiso para ver esta factura."),
    ).toBeTruthy();
    expect(screen.queryByText("Proveedor 3")).toBeNull();
  });
});

describe("«Limpiar filtros» also clears the unsubmitted search text (CR-359)", () => {
  it("empties a draft that was typed but never submitted", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    fireEvent.click(screen.getByRole("radio", { name: "Pendientes" }));
    const box = (await screen.findByLabelText(
      "Buscar por número o proveedor",
    )) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "borrador" } });
    expect(box.value).toBe("borrador");
    fireEvent.click(
      await screen.findByRole("button", { name: "Limpiar filtros" }),
    );
    await waitFor(() => expect(search().has("businessStatus")).toBe(false));
    expect(
      (
        screen.getByLabelText(
          "Buscar por número o proveedor",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });
});

describe("status chip labels (CR-362)", () => {
  it("uses the explicit plural of each status", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    expect(
      within(screen.getByRole("radiogroup", { name: "Estado de la factura" }))
        .getAllByRole("radio")
        .map((radio) => radio.parentElement?.textContent),
    ).toEqual(["Todas", "Pendientes", "Aprobadas", "Rechazadas", "Canceladas"]);
  });
});

describe("re-review 2: stale page text and live regions (CR-380, CR-389)", () => {
  const pageOf = (query: string) =>
    Number(new URLSearchParams(query).get("page") ?? 1);
  const countRegion = () =>
    document.querySelector<HTMLElement>(".inbox-count") as HTMLElement;

  it("shows neither the new range nor the old total while page 2 loads", async () => {
    const next = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : next.promise,
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const region = countRegion();
    expect(region.textContent).toBe("41 facturas");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(search().get("page")).toBe("2"));
    // The rows on screen are page 1's: no range of page 2 over them, and the
    // live region does not announce the total of the data being replaced.
    expect(screen.queryByText(/Mostrando 21/)).toBeNull();
    expect(screen.queryByText(/Mostrando/)).toBeNull();
    expect(region.textContent).toBe("Actualizando…");
    expect(region.textContent).not.toContain("41");
    expect(screen.getByText("Página 1 de 3")).toBeTruthy();
    await act(async () => {
      next.resolve(invoicePage([invoice(21)], { page: 2, total: 42 }));
      await Promise.resolve();
    });
    expect(await screen.findByText("Mostrando 21–21 de 42")).toBeTruthy();
    // The same node announced both: the region outlives the change.
    expect(countRegion()).toBe(region);
    expect(region.textContent).toBe("42 facturas");
  });

  it("does not announce the old total while a filter of the same scope loads", async () => {
    const next = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("businessStatus")
        ? next.promise
        : invoicePage([invoice(1)], { total: 57 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByText("57 facturas");
    fireEvent.click(screen.getByRole("radio", { name: "Pendientes" }));
    await waitFor(() => expect(search().get("businessStatus")).toBe("PENDING"));
    expect(screen.queryByText("57 facturas")).toBeNull();
    expect(screen.queryByText(/Mostrando/)).toBeNull();
    expect(countRegion().textContent).toBe("Actualizando…");
    await act(async () => {
      next.resolve(invoicePage([invoice(2)], { total: 3 }));
      await Promise.resolve();
    });
    expect(await screen.findByText("3 facturas")).toBeTruthy();
  });

  it("dims the stale rows through aria-busy styles that respect reduced motion", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toMatch(/\.data-table\[aria-busy="true"\]\s*{[^}]*opacity/);
    expect(styles).toMatch(/\.data-table\s*{[^}]*transition:\s*opacity/);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*{\s*\.data-table\s*{\s*transition:\s*none/,
    );
  });

  it("keeps the loading status mounted before the message appears", async () => {
    const pending = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("ungrouped")
        ? pending.promise
        : invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const before = screen.getAllByRole("status");
    await selectContext("Sin grupo asignado");
    const loading = await screen.findByText("Cargando facturas…");
    expect(before).toContain(loading);
    expect(loading.closest("[aria-busy]")).toBeNull();
    pending.resolve(invoicePage([]));
    await screen.findByText(/Todavía no hay facturas/);
    expect(loading.isConnected).toBe(true);
    expect(loading.textContent).toBe("");
  });

  it("keeps the groups notice region mounted before the failure arrives", async () => {
    const groups = deferred<Response>();
    inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => groups.promise,
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const before = screen.getAllByRole("status");
    groups.resolve(errorResponse(500, "INTERNAL"));
    const notice = await screen.findByText(/No fue posible cargar todos/);
    expect(before).toContain(notice.closest("[role=status]"));
  });
});

describe("re-review 2: focus, retry guards and pagination (CR-382, CR-385, CR-386)", () => {
  const pageOf = (query: string) =>
    Number(new URLSearchParams(query).get("page") ?? 1);

  it("moves focus to «Reintentar» when the page being loaded fails", async () => {
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : errorResponse(500, "INTERNAL"),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const next = screen.getByRole("button", { name: "Siguiente" });
    next.focus();
    fireEvent.click(next);
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Reintentar" }),
    );
  });

  it("does not steal focus to «Reintentar» when focus was elsewhere", async () => {
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : errorResponse(500, "INTERNAL"),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("alert");
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Reintentar" }),
    );
  });

  it("ignores a second «Reintentar» while the retry is in flight and keeps focus", async () => {
    const slow = deferred<Response>();
    let hold = false;
    const transport = inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : hold
          ? slow.promise
          : errorResponse(500, "INTERNAL"),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    hold = true;
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(3));
    await waitFor(() =>
      expect(retry.getAttribute("aria-disabled")).toBe("true"),
    );
    fireEvent.click(retry);
    expect(transport.calls(LIST)).toHaveLength(3);
    expect(document.activeElement).toBe(retry);
    slow.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
    await screen.findByRole("link", { name: "FAC-21" });
  });

  it("ignores a second groups «Reintentar» while the retry is in flight", async () => {
    const slow = deferred<Response>();
    let asked = 0;
    const transport = inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => (++asked === 1 ? errorResponse(500, "INTERNAL") : slow.promise),
    );
    renderApp({ route: "/invoices" });
    const notice = await screen.findByText(/No fue posible cargar todos/);
    const retry = within(
      notice.closest("[role=status]") as HTMLElement,
    ).getByRole("button", { name: "Reintentar" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(transport.calls(ORG_GROUPS)).toHaveLength(2));
    await waitFor(() =>
      expect(retry.getAttribute("aria-disabled")).toBe("true"),
    );
    fireEvent.click(retry);
    expect(transport.calls(ORG_GROUPS)).toHaveLength(2);
    expect(document.activeElement).toBe(retry);
    slow.resolve(groupsOf(contabilidad));
  });

  it("lets «Siguiente» navigate while a background refetch is in flight", async () => {
    const slow = deferred<Response>();
    let hold = false;
    inboxTransport(orgReader, () =>
      hold ? slow.promise : invoicePage([invoice(1)], { total: 41 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Actualizar" })
          .getAttribute("aria-busy"),
      ).toBe("true"),
    );
    const next = screen.getByRole("button", { name: "Siguiente" });
    expect(next.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(next);
    await waitFor(() => expect(search().get("page")).toBe("2"));
    slow.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
  });

  it("moves focus to the search box after «Limpiar filtros» of the toolbar", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({
      route: `/invoices?organizationId=${norte.id}&businessStatus=APPROVED`,
    });
    await screen.findByRole("table", { name: "Facturas" });
    const clear = screen.getByRole("button", { name: "Limpiar filtros" });
    clear.focus();
    fireEvent.click(clear);
    await waitFor(() => expect(search().has("businessStatus")).toBe(false));
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Buscar por número o proveedor" }),
    );
  });

  it("moves focus to the search box after «Limpiar filtros» of the empty state", async () => {
    inboxTransport(orgReader, () => invoicePage([]));
    renderApp({ route: `/invoices?organizationId=${norte.id}&q=zzz` });
    await screen.findByRole("heading", {
      name: "Ninguna factura coincide con los filtros",
    });
    const buttons = screen.getAllByRole("button", { name: "Limpiar filtros" });
    const emptyState = buttons[buttons.length - 1]!;
    emptyState.focus();
    fireEvent.click(emptyState);
    await waitFor(() => expect(search().has("q")).toBe(false));
    expect(document.activeElement).toBe(
      screen.getByRole("searchbox", { name: "Buscar por número o proveedor" }),
    );
  });
});

describe("re-review 2: date filters (CR-387)", () => {
  it("applies a date only when complete and valid, replacing the history entry", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    const from = screen.getByLabelText("Desde") as HTMLInputElement;
    const length = window.history.length;
    // Partial years are what a date input reports while the year is typed.
    for (const partial of ["0002-03-04", "0202-03-04", "1899-12-31"]) {
      fireEvent.change(from, { target: { value: partial } });
      expect(from.value).toBe(partial);
    }
    expect(search().has("issuedFrom")).toBe(false);
    expect(transport.calls(LIST)).toHaveLength(1);
    expect(window.history.length).toBe(length);
    fireEvent.change(from, { target: { value: "2026-01-05" } });
    await waitFor(() => expect(search().get("issuedFrom")).toBe("2026-01-05"));
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!).issuedFrom).toBe("2026-01-05");
    expect(window.history.length).toBe(length);
    fireEvent.change(from, { target: { value: "" } });
    await waitFor(() => expect(search().has("issuedFrom")).toBe(false));
    expect(window.history.length).toBe(length);
  });

  it("still pushes a history entry for a status change", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    const length = window.history.length;
    fireEvent.click(screen.getByRole("radio", { name: "Pendientes" }));
    await waitFor(() => expect(search().get("businessStatus")).toBe("PENDING"));
    expect(window.history.length).toBe(length + 1);
  });
});

describe("re-review 3: date filters (CR-400, CR-401, CR-407)", () => {
  const route = (query: string) => `/invoices?${query}`;
  const markBadInput = (input: HTMLInputElement, badInput: boolean) =>
    Object.defineProperty(input, "validity", {
      configurable: true,
      value: { badInput },
    });
  const navigateTo = async (url: string) => {
    await act(async () => {
      window.history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  };

  it("keeps the filter while the input reports unparsable text (badInput)", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: route("issuedFrom=2026-01-05") });
    await screen.findByRole("table", { name: "Facturas" });
    const from = screen.getByLabelText("Desde") as HTMLInputElement;
    expect(from.value).toBe("2026-01-05");
    const asked = transport.calls(LIST).length;
    markBadInput(from, true);
    fireEvent.change(from, { target: { value: "" } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(from.value).toBe("");
    expect(search().get("issuedFrom")).toBe("2026-01-05");
    expect(transport.calls(LIST)).toHaveLength(asked);
  });

  it("still clears the filter when the input was really emptied", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: route("issuedFrom=2026-01-05") });
    await screen.findByRole("table", { name: "Facturas" });
    const from = screen.getByLabelText("Desde") as HTMLInputElement;
    markBadInput(from, false);
    fireEvent.change(from, { target: { value: "" } });
    await waitFor(() => expect(search().has("issuedFrom")).toBe(false));
    await waitFor(() => expect(transport.calls(LIST)).toHaveLength(2));
    expect(queryOf(transport.calls(LIST)[1]!).issuedFrom).toBeUndefined();
  });

  it("ignores a URL date before 1900 exactly like the box does", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: route("issuedFrom=0002-01-01&issuedTo=1899-12-31") });
    await screen.findByRole("table", { name: "Facturas" });
    const request = queryOf(transport.calls(LIST)[0]!);
    expect(request.issuedFrom).toBeUndefined();
    expect(request.issuedTo).toBeUndefined();
    expect((screen.getByLabelText("Desde") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Hasta") as HTMLInputElement).value).toBe("");
  });

  it("offers 1900 as the minimum and explains a complete earlier date once the box loses focus", async () => {
    const transport = inboxTransport(orgReader, () =>
      invoicePage([invoice(1)]),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("table", { name: "Facturas" });
    for (const label of ["Desde", "Hasta"])
      expect(screen.getByLabelText(label).getAttribute("min")).toBe(
        "1900-01-01",
      );
    const from = screen.getByLabelText("Desde") as HTMLInputElement;
    fireEvent.change(from, { target: { value: "1899-12-31" } });
    // Still typing the year: nothing is said yet.
    expect(screen.queryByText("La fecha debe ser desde 1900.")).toBeNull();
    fireEvent.blur(from);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "La fecha debe ser desde 1900.",
    );
    expect(from.getAttribute("aria-describedby")).toBe(
      screen.getByRole("alert").id,
    );
    expect(transport.calls(LIST)).toHaveLength(1);
    fireEvent.change(from, { target: { value: "2026-01-05" } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("adopts an outside change (Back, a link) and drops the typed draft", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({ route: route("issuedFrom=2026-01-05") });
    await screen.findByRole("table", { name: "Facturas" });
    const from = screen.getByLabelText("Desde") as HTMLInputElement;
    const to = screen.getByLabelText("Hasta") as HTMLInputElement;
    // A draft that is not applicable stays local...
    fireEvent.change(from, { target: { value: "0002-03-04" } });
    fireEvent.change(to, { target: { value: "0202-03-04" } });
    expect(from.value).toBe("0002-03-04");
    // ...until the URL changes from outside.
    await navigateTo(route("issuedFrom=2026-02-01"));
    await waitFor(() => expect(from.value).toBe("2026-02-01"));
    expect(to.value).toBe("0202-03-04");
    // A date cleared from the URL empties the box.
    await navigateTo("/invoices");
    await waitFor(() => expect(from.value).toBe(""));
  });
});

describe("re-review 3: retry of a failed page (CR-402, CR-407)", () => {
  const pageOf = (query: string) =>
    Number(new URLSearchParams(query).get("page") ?? 1);

  it("renders no row of another page and keeps the alert text while the retry runs", async () => {
    const slow = deferred<Response>();
    let hold = false;
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : hold
          ? slow.promise
          : errorResponse(400, "VALIDATION_ERROR"),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const failure =
      "Los filtros elegidos no son válidos. Cámbialos e intenta nuevamente.";
    expect((await screen.findByRole("alert")).textContent).toBe(failure);
    hold = true;
    const retry = screen.getByRole("button", { name: "Reintentar" });
    fireEvent.click(retry);
    await waitFor(() => expect(retry.textContent).toBe("Reintentando…"));
    expect(screen.queryByRole("link", { name: "FAC-1" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(failure);
    slow.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
    expect(await screen.findByRole("link", { name: "FAC-21" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the new page's state when the page changes during a retry", async () => {
    const slow = deferred<Response>();
    let hold = false;
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : hold
          ? slow.promise
          : errorResponse(500, "INTERNAL"),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("alert");
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("button", { name: "Reintentando…" });
    await act(async () => {
      window.history.pushState(null, "", "/invoices");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("link", { name: "FAC-1" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    slow.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
  });

  it("shows the new scope's state when the scope changes during a retry", async () => {
    const slow = deferred<Response>();
    let hold = false;
    inboxTransport(orgReader, ({ search: query }) => {
      const params = new URLSearchParams(query);
      if (params.has("ungrouped")) return invoicePage([invoice(30)]);
      return pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 41 })
        : hold
          ? slow.promise
          : errorResponse(500, "INTERNAL");
    });
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("alert");
    hold = true;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("button", { name: "Reintentando…" });
    await selectContext("Sin grupo asignado");
    expect(await screen.findByRole("link", { name: "FAC-30" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    slow.resolve(invoicePage([invoice(21)], { page: 2, total: 41 }));
  });

  it("keeps the groups notice through the retry without copying state", async () => {
    const slow = deferred<Response>();
    let asked = 0;
    inboxTransport(
      orgReader,
      () => invoicePage([invoice(1)]),
      () => (++asked === 1 ? errorResponse(500, "INTERNAL") : slow.promise),
    );
    renderApp({ route: "/invoices" });
    const notice = await screen.findByText(/No fue posible cargar todos/);
    fireEvent.click(
      within(notice.closest("[role=status]") as HTMLElement).getByRole(
        "button",
        { name: "Reintentar" },
      ),
    );
    await waitFor(() => expect(asked).toBe(2));
    expect(screen.getByText(/No fue posible cargar todos/)).toBeTruthy();
    slow.resolve(groupsOf(contabilidad));
    await waitFor(() =>
      expect(screen.queryByText(/No fue posible cargar todos/)).toBeNull(),
    );
  });
});

describe("re-review 3: focus (CR-403, CR-404, CR-405, CR-407)", () => {
  const pageOf = (query: string) =>
    Number(new URLSearchParams(query).get("page") ?? 1);

  it("keeps the focus on «Siguiente» when it reaches the last page", async () => {
    inboxTransport(orgReader, ({ search: query }) =>
      pageOf(query) === 1
        ? invoicePage([invoice(1)], { total: 21 })
        : invoicePage([invoice(21)], { page: 2, total: 21 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    const next = screen.getByRole("button", { name: "Siguiente" });
    next.focus();
    fireEvent.click(next);
    await screen.findByRole("link", { name: "FAC-21" });
    expect(screen.getByRole("button", { name: "Siguiente" })).toBe(next);
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(next);
    // At the end the click does nothing.
    fireEvent.click(next);
    expect(search().get("page")).toBe("2");
  });

  it("does not move the focus to «Reintentar» after the footer was lost for another reason", async () => {
    const failing = deferred<Response>();
    inboxTransport(orgReader, ({ search: query }) =>
      new URLSearchParams(query).has("ungrouped")
        ? failing.promise
        : invoicePage([invoice(1)], { total: 41 }),
    );
    renderApp({ route: "/invoices" });
    await screen.findByRole("link", { name: "FAC-1" });
    screen.getByRole("button", { name: "Siguiente" }).focus();
    // The scope changes: the footer goes away with the focus in it.
    await selectContext("Sin grupo asignado");
    await screen.findByText("Cargando facturas…");
    expect(screen.queryByRole("button", { name: "Siguiente" })).toBeNull();
    // That scope then fails: nobody had the focus in a footer any more.
    await act(async () => {
      failing.resolve(errorResponse(500, "INTERNAL"));
      await Promise.resolve();
    });
    await screen.findByRole("alert");
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Reintentar" }),
    );
  });

  it("gives the focus to the scope selector, not the search box, after a touch tap on «Limpiar filtros»", async () => {
    inboxTransport(orgReader, () => invoicePage([invoice(1)]));
    renderApp({
      route: `/invoices?organizationId=${norte.id}&businessStatus=APPROVED`,
    });
    await screen.findByRole("table", { name: "Facturas" });
    const clear = screen.getByRole("button", { name: "Limpiar filtros" });
    fireEvent(
      clear,
      new PointerEvent("click", { bubbles: true, pointerType: "touch" }),
    );
    await waitFor(() => expect(search().has("businessStatus")).toBe(false));
    expect(document.activeElement).toBe(
      screen.getByLabelText("Ver facturas de"),
    );
  });
});
