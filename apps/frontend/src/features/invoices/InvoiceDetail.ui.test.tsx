import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import {
  compras,
  contabilidad,
  finanzas,
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
import {
  groupInvoicesKey,
  invoiceKey,
  orgInvoicesKey,
} from "../auth/session/queryKeys";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const LIST = "GET /api/v1/invoices";
const detailPath = (id: string) => `/api/v1/invoices/${id}`;

function detailTransport(
  detail: RouteHandler,
  id: string,
  profile: () => Record<string, unknown> = orgReader,
) {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: profile() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [LIST]: () => invoicePage([invoice(1)]),
    [`GET ${detailPath(id)}`]: detail,
  });
}

const definition = (term: string) =>
  screen.getByText(term, { selector: "dt" }).nextElementSibling?.textContent;

// Hidden announcements (CR-587) are not visible loading text.
const visibleText = (pattern: RegExp) =>
  screen
    .queryAllByText(pattern)
    .filter((element) => !element.closest(".visually-hidden"));

describe("invoice detail (AC-19)", () => {
  it("shows the business data and keeps both statuses apart", async () => {
    const found = invoice(7, {
      groupId: contabilidad.id,
      amountPesos: 987654,
      businessStatus: "REJECTED",
      issuedOn: "2026-02-03",
      dueOn: "2026-03-04",
    });
    const transport = detailTransport(
      () => jsonResponse({ invoice: found }),
      found.id,
    );
    renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}&groupId=${contabilidad.id}`,
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "FAC-7" }),
    ).toBeTruthy();
    const header = screen
      .getByRole("heading", { level: 1 })
      .closest("header") as HTMLElement;
    expect(within(header).getByText("Proveedor 7")).toBeTruthy();
    expect(within(header).getByText("Rechazada")).toBeTruthy();
    expect(
      screen.getByText("Monto").parentElement?.textContent?.replace(/\s/g, " "),
    ).toBe("Monto$987.654");
    expect(definition("Emisión")).toBe("03-02-2026");
    expect(definition("Vencimiento")).toBe("04-03-2026");
    expect(definition("Procesamiento")).toBe("Sin procesamiento");
    expect(definition("Grupo")).toBe("Contabilidad");
    expect(document.body.textContent).not.toContain("NOT_REQUESTED");
    expect(document.body.textContent).not.toContain(found.createdByUserId);
    const [request] = transport.calls(`GET ${detailPath(found.id)}`);
    expect(queryOf(request!)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
    });
  });

  it("shows the id as title, the status beside it, a prominent amount and no «contexto»", async () => {
    const found = invoice(9, {
      businessStatus: "APPROVED",
      dueOn: "2020-01-01",
    });
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    const title = await screen.findByRole("heading", {
      level: 1,
      name: "FAC-9",
    });
    const header = title.closest("header") as HTMLElement;
    expect(within(header).getByText("Aprobada")).toBeTruthy();
    expect(within(header).getByText("Proveedor 9")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Volver a facturas" }),
    ).toBeTruthy();
    // Only a PENDING invoice is past due.
    expect(screen.queryByText("Vencida")).toBeNull();
    expect(document.body.textContent).not.toMatch(/contexto/i);
  });

  it("flags a past-due PENDING invoice with «Vencida» next to its due date", async () => {
    const found = invoice(10, { dueOn: "2020-01-01" });
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: "FAC-10" });
    expect(definition("Vencimiento")).toContain("Vencida");
  });

  it("shows the group name from the API for a group the person is not a member of", async () => {
    const found = invoice(8, { groupId: finanzas.id });
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}&groupId=${finanzas.id}`,
    });
    await screen.findByRole("heading", { level: 1, name: "FAC-8" });
    expect(definition("Grupo")).toBe("Finanzas");
    expect(document.body.textContent).not.toContain("Otro grupo");
  });

  it("says «Sin grupo» and sends no group for an organization-scope invoice", async () => {
    const found = invoice(8);
    const transport = detailTransport(
      () => jsonResponse({ invoice: found }),
      found.id,
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: "FAC-8" });
    expect(definition("Grupo")).toBe("Sin grupo");
    expect(queryOf(transport.calls(`GET ${detailPath(found.id)}`)[0]!)).toEqual(
      {
        organizationId: norte.id,
      },
    );
  });

  it("offers no delete or create action without a delete flag", async () => {
    const found = invoice(8);
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: "FAC-8" });
    expect(
      screen.queryByRole("button", { name: /eliminar|borrar|crear/i }),
    ).toBeNull();
  });

  it("opens from an inbox row and goes back to the inbox with its filters", async () => {
    const found = invoice(3, { groupId: contabilidad.id });
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: orgReader() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [LIST]: () => invoicePage([found]),
      [`GET ${detailPath(found.id)}`]: () => jsonResponse({ invoice: found }),
    });
    renderApp({
      route: `/invoices?organizationId=${norte.id}&groupId=${contabilidad.id}&businessStatus=PENDING&q=prov`,
    });
    fireEvent.click(await screen.findByRole("link", { name: "FAC-3" }));
    await screen.findByRole("heading", { level: 1, name: "FAC-3" });
    expect(window.location.pathname).toBe(`/invoices/${found.id}`);
    fireEvent.click(screen.getByRole("link", { name: "Volver a facturas" }));
    await screen.findByRole("table", { name: "Facturas" });
    expect(window.location.pathname).toBe("/invoices");
    const params = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(params)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
      businessStatus: "PENDING",
      q: "prov",
    });
    // AC-07: both selects are restored from the URL.
    expect(
      (screen.getByLabelText("Organización") as HTMLSelectElement).value,
    ).toBe(norte.id);
    expect((screen.getByLabelText("Grupo") as HTMLSelectElement).value).toBe(
      `group:${norte.id}:${contabilidad.id}`,
    );
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(1);
  });

  it("goes back to the inbox of the invoice's context after a direct visit", async () => {
    const found = invoice(4, { groupId: contabilidad.id });
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}&groupId=${contabilidad.id}`,
    });
    await screen.findByRole("heading", { level: 1, name: "FAC-4" });
    const href = screen
      .getByRole("link", { name: "Volver a facturas" })
      .getAttribute("href")!;
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/invoices");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
    });
  });

  it("announces loading, then recovers from an error with «Reintentar»", async () => {
    const found = invoice(5);
    let fail = true;
    const pending = deferred<Response>();
    const transport = detailTransport(
      () => (fail ? pending.promise : jsonResponse({ invoice: found })),
      found.id,
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    expect((await screen.findAllByTestId("skeleton")).length).toBeGreaterThan(
      0,
    );
    expect(visibleText(/Cargando/)).toEqual([]);
    pending.resolve(errorResponse(500, "INTERNAL"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar la factura.",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("heading", { level: 1, name: "FAC-5" });
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(2);
  });

  it("answers 404 with «Factura no encontrada» and a link back, and drops the entry on leaving (CR-381)", async () => {
    const missing = invoice(6);
    const transport = detailTransport(
      () => errorResponse(404, "NOT_FOUND"),
      missing.id,
    );
    const { store } = renderApp({
      route: `/invoices/${missing.id}?organizationId=${norte.id}`,
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Factura no encontrada",
      }),
    ).toBeTruthy();
    const back = screen.getByRole("link", { name: "Volver a facturas" });
    expect(new URL(back.getAttribute("href")!, "http://x").pathname).toBe(
      "/invoices",
    );
    const cached = () =>
      store
        .getSnapshot()
        .client.getQueryCache()
        .getAll()
        .some((query) => query.queryKey.includes("invoice"));
    // The active entry stays while the screen is up, so a later render of the
    // parent finds the answer instead of asking again.
    expect(cached()).toBe(true);
    await act(async () => {
      window.history.pushState(
        null,
        "",
        `/invoices/${missing.id}?organizationId=${norte.id}&x=1`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Factura no encontrada" }),
    ).toBeTruthy();
    expect(transport.calls(`GET ${detailPath(missing.id)}`)).toHaveLength(1);
    // Leaving the screen drops it.
    fireEvent.click(screen.getByRole("link", { name: "Volver a facturas" }));
    await screen.findByRole("table", { name: "Facturas" });
    expect(cached()).toBe(false);
  });

  it("does not request a malformed id and shows the same not-found screen", async () => {
    const transport = detailTransport(() => jsonResponse({}), invoice(1).id);
    renderApp({ route: `/invoices/no-es-un-id?organizationId=${norte.id}` });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Factura no encontrada",
      }),
    ).toBeTruthy();
    expect(
      transport.requests.some(({ path }) => path.includes("no-es-un-id")),
    ).toBe(false);
  });

  it("does not request a detail without a valid organization", async () => {
    const found = invoice(1);
    const transport = detailTransport(
      () => jsonResponse({ invoice: found }),
      found.id,
    );
    renderApp({ route: `/invoices/${found.id}` });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Factura no encontrada",
      }),
    ).toBeTruthy();
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(0);
  });

  it("a 403 hides the invoice, refreshes the profile and offers the way back", async () => {
    const found = invoice(9);
    let revoked = false;
    const transport = detailTransport(
      () => {
        revoked = true;
        return errorResponse(403, "FORBIDDEN");
      },
      found.id,
      () => (revoked ? profileFixture() : orgReader()),
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    expect(
      await screen.findByText("No tienes permiso para ver esta factura."),
    ).toBeTruthy();
    expect(screen.queryByText("Proveedor 9")).toBeNull();
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/auth/profile").length,
      ).toBeGreaterThan(1),
    );
    expect(
      screen.getByRole("link", { name: "Volver a facturas" }),
    ).toBeTruthy();
  });

  it("keeps the detail under the documented key", async () => {
    const found = invoice(2);
    detailTransport(() => jsonResponse({ invoice: found }), found.id);
    const { store } = renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}`,
    });
    await screen.findByRole("heading", { level: 1, name: "FAC-2" });
    expect(
      store
        .getSnapshot()
        .client.getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual(["identity", ME, "org", norte.id, "invoice", found.id]);
  });
});

// --- Deletion (RP0-15: AC-20, AC-21) ---

const DELETE_OTHERS = {
  ...READ,
  deleteOthersInvoices: true,
  deployModels: false,
};
const DELETE_OWN = { ...READ, deleteOwnInvoices: true };

const profileWith = (permissions: typeof READ) => () =>
  profileFixture({
    memberships: [
      membership(norte, "USER", {
        permissions,
        groups: [{ group: contabilidad, effective: READ }],
      }),
    ],
  });

function deletionSetup(
  found: ReturnType<typeof invoice>,
  del: RouteHandler,
  profile: () => Record<string, unknown> = profileWith(DELETE_OTHERS),
  detail: RouteHandler = () => jsonResponse({ invoice: found }),
) {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: profile() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [LIST]: () => invoicePage([found]),
    [`GET ${detailPath(found.id)}`]: detail,
    [`DELETE ${detailPath(found.id)}`]: del,
  });
}

const DELETE_LABEL = "Eliminar factura";
const noContent = () => new Response(null, { status: 204 });

async function openDialog(n: number) {
  await screen.findByRole("heading", { level: 1, name: `FAC-${n}` });
  const trigger = await screen.findByRole("button", { name: DELETE_LABEL });
  fireEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog") };
}

const confirmButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: DELETE_LABEL });

describe("invoice deletion (AC-20)", () => {
  it("offers the action only when the applicable effective flag is set", async () => {
    const others = invoice(1);
    deletionSetup(others, noContent);
    const first = renderApp({
      route: `/invoices/${others.id}?organizationId=${norte.id}`,
    });
    expect(
      await screen.findByRole("button", { name: DELETE_LABEL }),
    ).toBeTruthy();
    first.unmount();
    vi.restoreAllMocks();

    const own = invoice(2, { createdByUserId: ME });
    deletionSetup(own, noContent);
    renderApp({ route: `/invoices/${own.id}?organizationId=${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: "FAC-2" });
    // deleteOthers does not cover my own invoice.
    expect(screen.queryByRole("button", { name: DELETE_LABEL })).toBeNull();
  });

  it("offers the action for an own invoice with deleteOwn only", async () => {
    const own = invoice(3, { createdByUserId: ME });
    deletionSetup(own, noContent, profileWith(DELETE_OWN));
    renderApp({ route: `/invoices/${own.id}?organizationId=${norte.id}` });
    expect(
      await screen.findByRole("button", { name: DELETE_LABEL }),
    ).toBeTruthy();
  });

  it("does not offer the action without any delete flag, and has no delete in the inbox rows", async () => {
    const found = invoice(4);
    deletionSetup(found, noContent, orgReader);
    renderApp({ route: `/invoices?organizationId=${norte.id}` });
    await screen.findByRole("link", { name: "FAC-4" });
    expect(screen.queryByRole("button", { name: /eliminar/i })).toBeNull();
  });

  it("opens a modal naming the invoice; «Cancelar» sends nothing and returns focus", async () => {
    const found = invoice(5);
    const transport = deletionSetup(found, noContent);
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    const { trigger, dialog } = await openDialog(5);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain("FAC-5");
    expect(dialog.textContent).toContain("Proveedor 5");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(0);
  });

  it("Escape closes the modal without sending DELETE", async () => {
    const found = invoice(5);
    const transport = deletionSetup(found, noContent);
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    const { trigger, dialog } = await openDialog(5);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(0);
  });

  it("a double click on the confirmation sends exactly one DELETE", async () => {
    const found = invoice(6, { groupId: contabilidad.id });
    const pending = deferred<Response>();
    const transport = deletionSetup(found, () => pending.promise);
    renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}&groupId=${contabilidad.id}`,
    });
    const { dialog } = await openDialog(6);
    const confirm = confirmButton(dialog);
    confirm.focus();
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    // CR-360: the pending state is spoken, labelled and keeps the focus.
    await waitFor(() =>
      expect(confirm.getAttribute("aria-disabled")).toBe("true"),
    );
    // No «Eliminando…» text: same label, busy, spinner, hidden announcement.
    expect(confirm.textContent).toBe("Eliminar factura");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(within(dialog).getByRole("status").textContent).toBe(
      "Eliminando factura",
    );
    expect(document.activeElement).toBe(confirm);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(1);
    const [request] = transport.calls(`DELETE ${detailPath(found.id)}`);
    expect(queryOf(request!)).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
    });
    // While pending neither «Cancelar» nor Escape dismisses the dialog.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeTruthy();
    await act(async () => pending.resolve(noContent()));
    await screen.findByText(/Factura eliminada/);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(1);
  });
});

describe("invoice deletion (AC-21)", () => {
  it("on 204 returns to the inbox it came from, confirms, and resets only the affected lists", async () => {
    const found = invoice(7, { groupId: contabilidad.id });
    let deleted = false;
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: profileWith(DELETE_OTHERS)() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [LIST]: () => invoicePage(deleted ? [] : [found]),
      [`GET ${detailPath(found.id)}`]: () =>
        deleted
          ? errorResponse(404, "NOT_FOUND")
          : jsonResponse({ invoice: found }),
      [`DELETE ${detailPath(found.id)}`]: () => {
        deleted = true;
        return noContent();
      },
    });
    const { store } = renderApp({
      route: `/invoices?organizationId=${norte.id}&groupId=${contabilidad.id}&businessStatus=PENDING&q=prov`,
    });
    fireEvent.click(await screen.findByRole("link", { name: "FAC-7" }));
    const client = store.getSnapshot().client;
    await screen.findByRole("heading", { level: 1, name: "FAC-7" });
    const seed = (key: readonly unknown[]) => client.setQueryData(key, {});
    const affected = [
      groupInvoicesKey(ME, norte.id, contabilidad.id, { seed: 1 }),
      orgInvoicesKey(ME, norte.id, { seed: 1 }),
      orgInvoicesKey(ME, norte.id, { seed: 2, ungrouped: true }),
    ];
    const untouched = [
      groupInvoicesKey(ME, norte.id, compras.id, { seed: 1 }),
      orgInvoicesKey(ME, sur.id, { seed: 1 }),
    ];
    for (const key of [...affected, ...untouched]) seed(key);
    // A reset leaves no data to paint; an untouched list keeps its entry.
    const wasReset = (key: readonly unknown[]) =>
      client.getQueryData(key) === undefined;

    const { dialog } = await openDialog(7);
    fireEvent.click(confirmButton(dialog));

    await screen.findByText(/Factura eliminada/);
    expect(window.location.pathname).toBe("/invoices");
    expect(
      Object.fromEntries(new URLSearchParams(window.location.search)),
    ).toEqual({
      organizationId: norte.id,
      groupId: contabilidad.id,
      businessStatus: "PENDING",
      q: "prov",
    });
    await waitFor(() =>
      expect(client.getQueryState(invoiceKey(ME, norte.id, found.id))).toBe(
        undefined,
      ),
    );
    for (const key of affected) expect(wasReset(key)).toBe(true);
    for (const key of untouched) expect(wasReset(key)).toBe(false);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(1);
    // The deleted invoice is not asked for again.
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(1);
  });

  it("an in-flight detail response arriving after the delete does not resurrect it", async () => {
    const found = invoice(8);
    const late = deferred<Response>();
    let reads = 0;
    const transport = deletionSetup(
      found,
      noContent,
      profileWith(DELETE_OTHERS),
      () => (++reads === 1 ? jsonResponse({ invoice: found }) : late.promise),
    );
    const { store } = renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}`,
    });
    const { dialog } = await openDialog(8);
    const client = store.getSnapshot().client;
    void client.refetchQueries({
      queryKey: invoiceKey(ME, norte.id, found.id),
    });
    await waitFor(() =>
      expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(2),
    );
    fireEvent.click(confirmButton(dialog));
    await screen.findByText(/Factura eliminada/);
    // The stale read was cancelled by the delete: nothing is in flight.
    await waitFor(() =>
      expect(
        client.isFetching({ queryKey: invoiceKey(ME, norte.id, found.id) }),
      ).toBe(0),
    );
    await act(async () => {
      late.resolve(jsonResponse({ invoice: found }));
      await late.promise;
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    });
    expect(client.getQueryState(invoiceKey(ME, norte.id, found.id))).toBe(
      undefined,
    );
    expect(window.location.pathname).toBe("/invoices");
  });

  it("403 shows the permission error, refreshes the profile and never simulates success", async () => {
    const found = invoice(9);
    let revoked = false;
    const transport = deletionSetup(
      found,
      () => {
        revoked = true;
        return errorResponse(403, "FORBIDDEN");
      },
      () => (revoked ? profileWith(READ)() : profileWith(DELETE_OTHERS)()),
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    const { dialog } = await openDialog(9);
    fireEvent.click(confirmButton(dialog));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No tienes permiso para eliminar esta factura.",
    );
    expect(screen.queryByText(/Factura eliminada/)).toBeNull();
    expect(window.location.pathname).toBe(`/invoices/${found.id}`);
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/auth/profile").length,
      ).toBeGreaterThan(1),
    );
    // The refreshed profile no longer allows the action.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: DELETE_LABEL })).toBeNull(),
    );
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(1);
  });

  it("404 says the invoice no longer exists and drops the detail", async () => {
    const found = invoice(10);
    let gone = false;
    deletionSetup(
      found,
      () => {
        gone = true;
        return errorResponse(404, "NOT_FOUND");
      },
      profileWith(DELETE_OTHERS),
      () =>
        gone
          ? errorResponse(404, "NOT_FOUND")
          : jsonResponse({ invoice: found }),
    );
    const { store } = renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}`,
    });
    const { dialog } = await openDialog(10);
    fireEvent.click(confirmButton(dialog));
    expect(
      await screen.findByText("La factura ya no existe o no está disponible."),
    ).toBeTruthy();
    expect(screen.queryByText(/Factura eliminada/)).toBeNull();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Factura no encontrada",
      }),
    ).toBeTruthy();
    expect(
      store
        .getSnapshot()
        .client.getQueryData(invoiceKey(ME, norte.id, found.id)),
    ).toBeUndefined();
  });

  it("a 404 on delete shows «Factura no encontrada» without asking again and drops the entry on leaving (CR-408)", async () => {
    const found = invoice(12);
    const transport = deletionSetup(
      found,
      () => errorResponse(404, "NOT_FOUND"),
      profileWith(DELETE_OTHERS),
    );
    const { store } = renderApp({
      route: `/invoices/${found.id}?organizationId=${norte.id}`,
    });
    const { dialog } = await openDialog(12);
    fireEvent.click(confirmButton(dialog));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Factura no encontrada",
      }),
    ).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(1);
    const client = store.getSnapshot().client;
    const key = invoiceKey(ME, norte.id, found.id);
    // The mounted screen renders from the failed entry, which stays...
    expect(client.getQueryState(key)?.status).toBe("error");
    expect(client.getQueryData(key)).toBeUndefined();
    // ...and is dropped when the screen leaves it.
    fireEvent.click(screen.getByRole("link", { name: "Volver a facturas" }));
    await screen.findByRole("table", { name: "Facturas" });
    expect(client.getQueryState(key)).toBeUndefined();
    expect(transport.calls(`GET ${detailPath(found.id)}`)).toHaveLength(1);
  });

  it("503 asks to retry later, keeps the invoice and allows trying again", async () => {
    const found = invoice(11);
    let busy = true;
    const transport = deletionSetup(found, () =>
      busy ? errorResponse(503, "RETRYABLE_CONFLICT") : noContent(),
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    const { dialog } = await openDialog(11);
    fireEvent.click(confirmButton(dialog));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Intenta nuevamente/,
    );
    expect(screen.queryByText(/Factura eliminada/)).toBeNull();
    expect(window.location.pathname).toBe(`/invoices/${found.id}`);
    busy = false;
    const again = await openDialog(11);
    fireEvent.click(confirmButton(again.dialog));
    await screen.findByText(/Factura eliminada/);
    expect(transport.calls(`DELETE ${detailPath(found.id)}`)).toHaveLength(2);
  });
});

describe("returning from a deletion (CR-353)", () => {
  function deleteFlow(found: ReturnType<typeof invoice>) {
    let deleted = false;
    const lateList = deferred<Response>();
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({ profile: profileWith(DELETE_OTHERS)() }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [`GET /api/v1/organizations/${norte.id}/groups`]: () =>
        jsonResponse({ groups: [] }),
      [LIST]: () => (deleted ? lateList.promise : invoicePage([found])),
      [`GET ${detailPath(found.id)}`]: () => jsonResponse({ invoice: found }),
      [`DELETE ${detailPath(found.id)}`]: () => {
        deleted = true;
        return noContent();
      },
    });
    return { transport, lateList };
  }

  it("never paints the deleted row from the cache while the refreshed list is still loading", async () => {
    const found = invoice(12);
    const { lateList } = deleteFlow(found);
    renderApp({ route: `/invoices?organizationId=${norte.id}` });
    fireEvent.click(await screen.findByRole("link", { name: "FAC-12" }));
    const { dialog } = await openDialog(12);
    fireEvent.click(confirmButton(dialog));
    await screen.findByText(/Factura eliminada/);
    // The list answers later; until then the old page is not on screen.
    expect(screen.queryByRole("link", { name: "FAC-12" })).toBeNull();
    expect(await screen.findByText("Cargando facturas")).toBeTruthy();
    await act(async () => lateList.resolve(invoicePage([])));
    expect(await screen.findByText(/Todavía no hay facturas/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "FAC-12" })).toBeNull();
  });

  it("replaces the detail in the history: Back does not return to the deleted invoice", async () => {
    const found = invoice(13);
    const { lateList } = deleteFlow(found);
    renderApp({ route: `/invoices?organizationId=${norte.id}` });
    fireEvent.click(await screen.findByRole("link", { name: "FAC-13" }));
    const { dialog } = await openDialog(13);
    fireEvent.click(confirmButton(dialog));
    await screen.findByText(/Factura eliminada/);
    await act(async () => lateList.resolve(invoicePage([])));
    await screen.findByText(/Todavía no hay facturas/);
    const popped = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    await act(async () => {
      window.history.back();
      await popped;
    });
    // Back lands on the inbox entry the person started from.
    expect(window.location.pathname).toBe("/invoices");
    expect(
      screen.queryByRole("heading", { name: "Factura no encontrada" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { name: "FAC-13" })).toBeNull();
  });
});

describe("invoice detail: automatic predictions (MLOPS-06)", () => {
  const prediction = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`,
    deploymentId: `00000000-0000-4000-8000-0000000008${String(n).padStart(2, "0")}`,
    deploymentScope: "GROUP",
    registeredModel: "invoice-risk",
    modelVersion: String(n),
    runId: "run-1",
    probability: 0.37,
    status: "SUCCEEDED",
    errorCode: null,
    createdAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:05.000Z",
    ...overrides,
  });

  async function open(detailBody: Record<string, unknown>) {
    const found = invoice(31);
    detailTransport(
      () => jsonResponse({ invoice: found, ...detailBody }),
      found.id,
    );
    renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
    await screen.findByRole("heading", { level: 1, name: "FAC-31" });
  }

  it("shows the probability of rejection as a percentage with model and version", async () => {
    await open({ predictions: [prediction(3, { probability: 0.372 })] });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    expect(within(panel).getByText("invoice-risk · versión 3")).toBeTruthy();
    expect(within(panel).getByText("Probabilidad de rechazo")).toBeTruthy();
    expect(panel.textContent).toMatch(/37\s?%/);
    // The invoice summary stays intact.
    expect(
      screen.getByRole("group", { name: "Resumen de la factura" }),
    ).toBeTruthy();
  });

  it("never shows a tiny probability as zero", async () => {
    await open({ predictions: [prediction(3, { probability: 0.001 })] });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    expect(panel.textContent).toContain("menos de 1%");
  });

  it("labels each prediction as coming from an organization or a group model", async () => {
    await open({
      predictions: [
        prediction(3, { deploymentScope: "ORGANIZATION" }),
        prediction(4, { deploymentScope: "GROUP" }),
      ],
    });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    const [org, group] = within(panel).getAllByRole("listitem");
    expect(within(org!).getByText("Organización")).toBeTruthy();
    expect(within(group!).getByText("Grupo")).toBeTruthy();
  });

  it("shows pending and failed predictions without breaking the view", async () => {
    await open({
      predictions: [
        prediction(3, { status: "PENDING", probability: null }),
        prediction(4, {
          status: "FAILED",
          probability: null,
          errorCode: "MODEL_API_ERROR",
        }),
      ],
    });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    expect(within(panel).getByText("Pendiente")).toBeTruthy();
    // One signal for pending: the badge with its spinner, no skeleton.
    expect(within(panel).queryByTestId("skeleton")).toBeNull();
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(within(panel).getByText("Fallida")).toBeTruthy();
    expect(within(panel).queryByText(/No se pudo calcular/)).toBeNull();
    expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
    // The error code is for operators, not shown to people.
    expect(panel.textContent).not.toContain("MODEL_API_ERROR");
    expect(definition("Emisión")).toBeTruthy();
  });

  it("refetches the detail while a prediction is PENDING and stops once it settles", async () => {
    // Fake timers drive the poll: no real waiting, every fetch is counted.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const found = invoice(32);
      let reads = 0;
      detailTransport(() => {
        reads += 1;
        return jsonResponse({
          invoice: found,
          predictions: [
            reads < 2
              ? prediction(3, { status: "PENDING", probability: null })
              : prediction(3, { probability: 0.372 }),
          ],
        });
      }, found.id);
      renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
      const panel = await screen.findByRole("region", { name: "Predicciones" });
      expect(within(panel).getByText("Pendiente")).toBeTruthy();
      expect(reads).toBe(1);
      // First poll after 2 s, no reload needed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await waitFor(() => expect(panel.textContent).toMatch(/37\s?%/));
      const settledReads = reads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(reads).toBe(settledReads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the animation and offers a refresh when polling gives up (CR-552)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const found = invoice(34);
      let reads = 0;
      detailTransport(() => {
        reads += 1;
        return jsonResponse({
          invoice: found,
          predictions: [
            prediction(3, { status: "PENDING", probability: null }),
          ],
        });
      }, found.id);
      renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
      const panel = await screen.findByRole("region", { name: "Predicciones" });
      expect(panel.querySelector(".icon-spin")).not.toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
      });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Actualizar predicciones" }),
        ).toBeTruthy(),
      );
      expect(panel.querySelector(".icon-spin")).toBeNull();
      expect(within(panel).getByText("Pendiente")).toBeTruthy();
      const stopped = reads;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(reads).toBe(stopped);

      // Refreshing reads again and the section polls on from there.
      fireEvent.click(
        screen.getByRole("button", { name: "Actualizar predicciones" }),
      );
      await waitFor(() => expect(reads).toBe(stopped + 1));
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Actualizar predicciones" }),
        ).toBeNull(),
      );
      expect(panel.querySelector(".icon-spin")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a single refresh control when polling stopped because of an error (CR-591)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const found = invoice(35);
      let reads = 0;
      let failing = false;
      detailTransport(() => {
        reads += 1;
        if (failing) return errorResponse(500, "INTERNAL");
        return jsonResponse({
          invoice: found,
          predictions: [
            prediction(3, { status: "PENDING", probability: null }),
          ],
        });
      }, found.id);
      renderApp({ route: `/invoices/${found.id}?organizationId=${norte.id}` });
      await screen.findByRole("region", { name: "Predicciones" });
      failing = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      await screen.findByRole("alert");
      // «Reintentar» is the one control; the stalled icon is not shown too.
      expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Actualizar predicciones" }),
      ).toBeNull();
      failing = false;
      const before = reads;
      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      await waitFor(() => expect(reads).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows an explicit state for a SUCCEEDED prediction without probability (CR-571)", async () => {
    await open({
      predictions: [prediction(3, { status: "SUCCEEDED", probability: null })],
    });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    expect(within(panel).getByText("Sin resultado")).toBeTruthy();
    expect(within(panel).getByRole("list").getAttribute("aria-live")).toBe(
      "polite",
    );
  });

  it("is hidden when the API sends no predictions or an empty list", async () => {
    await open({});
    expect(screen.queryByRole("region", { name: "Predicciones" })).toBeNull();
    cleanup();
    await open({ predictions: [] });
    expect(screen.queryByRole("region", { name: "Predicciones" })).toBeNull();
  });

  it("shows a skipped prediction with one neutral «Omitida» badge (CR-581)", async () => {
    await open({
      predictions: [prediction(3, { status: "SKIPPED", probability: null })],
    });
    const panel = await screen.findByRole("region", { name: "Predicciones" });
    const badge = within(panel).getByText("Omitida");
    expect(badge.classList.contains("is-neutral")).toBe(true);
    expect(within(panel).queryByText("Probabilidad de rechazo")).toBeNull();
    expect(panel.getAttribute("aria-busy")).toBeNull();
  });
});
