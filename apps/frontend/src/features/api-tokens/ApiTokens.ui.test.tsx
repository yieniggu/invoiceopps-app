import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "../../test/renderApp";
import { uuid } from "../../test/ids";
import {
  compras,
  contabilidad,
  finanzas,
  groupsOf,
  norte,
  READ,
  sur,
} from "../../test/invoices";
import {
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  NO_PERMISSIONS,
  profileFixture,
  serializeClient,
  type RecordedRequest,
} from "../../test/transport";
import { formatInstant } from "../../lib/datetime";

// The secret of every emission in this file. It must only ever be found in
// the one dialog that shows it.
const SENTINEL = "iop_SENTINEL-0123456789abcdefghijklmnopqrstuvwxyz";
const DAY = 86_400_000;
// «Vence el …» as the screen formats it (CR-370): never a hand-written string
// that a change in the locale data would break.
const expiryText = (instant: Date) =>
  `Vence el ${formatInstant(instant.toISOString())}`;

const TOKENS = "/api/v1/api-tokens";
const ORG_GROUPS = `GET /api/v1/organizations/${norte.id}/groups`;

const CREATE_READ = {
  ...NO_PERMISSIONS,
  readInvoices: true,
  createInvoices: true,
};
const GROUP_FLAGS = {
  ...NO_PERMISSIONS,
  readInvoices: true,
  deleteOwnInvoices: true,
};

const me = () =>
  profileFixture({
    memberships: [
      membership(norte, "USER", {
        permissions: CREATE_READ,
        groups: [{ group: contabilidad, effective: GROUP_FLAGS }],
      }),
      membership(sur, "USER", {
        groups: [{ group: compras, effective: READ }],
      }),
    ],
  });

interface Token {
  id: string;
  name: string;
  organizationId: string;
  groupId: string | null;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

const token = (n: number, overrides: Partial<Token> = {}): Token => ({
  id: uuid(900 + n),
  name: `Token ${n}`,
  organizationId: norte.id,
  groupId: null,
  scopes: ["invoices:read"],
  createdAt: "2026-10-20T15:00:00.000Z",
  expiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
  revokedAt: null,
  ...overrides,
});

interface Options {
  tokens?: Token[];
  profile?: () => Record<string, unknown>;
  create?: (request: RecordedRequest) => Response | Promise<Response>;
  total?: number;
}

function setup({ tokens = [], profile = me, create, total }: Options = {}) {
  const store = { tokens };
  const transport = mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: profile() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [ORG_GROUPS]: () => groupsOf(contabilidad, finanzas),
    [`GET ${TOKENS}`]: ({ search }) => {
      const query = new URLSearchParams(search);
      const page = Number(query.get("page") ?? 1);
      const pageSize = Number(query.get("pageSize") ?? 20);
      const own = store.tokens.filter(
        (item) => item.organizationId === query.get("organizationId"),
      );
      return jsonResponse({
        items: own.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: total ?? own.length,
      });
    },
    [`POST ${TOKENS}`]:
      create ??
      ((request) => {
        const body = request.body as Partial<Token>;
        const issued = token(50, {
          name: body.name,
          organizationId: body.organizationId,
          groupId: body.groupId ?? null,
          scopes: body.scopes,
          expiresAt: body.expiresAt,
        });
        store.tokens = [issued, ...store.tokens];
        return jsonResponse({ token: issued, secret: SENTINEL }, 201);
      }),
    ...Object.fromEntries(
      Array.from({ length: 60 }, (_, n) => [
        `DELETE ${TOKENS}/${uuid(900 + n)}`,
        () => {
          store.tokens = store.tokens.map((item) =>
            item.id === uuid(900 + n)
              ? { ...item, revokedAt: new Date().toISOString() }
              : item,
          );
          return new Response(null, { status: 204 });
        },
      ]),
    ),
  });
  return { transport, store };
}

const consoleCalls: unknown[][] = [];
const setClipboard = (writeText: (text: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });

beforeEach(() => {
  consoleCalls.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const open = async (route = "/api-tokens", strict = false) => {
  const view = renderApp({ route, strict });
  await screen.findByRole("heading", { level: 1, name: "Tokens de API" });
  return view;
};

const openForm = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Emitir token" }));
  return screen.findByRole("dialog", { name: "Emitir token" });
};

/** The table no longer shows the previous page while the next one loads. */
const settled = () =>
  waitFor(() =>
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBeNull(),
  );

const civil = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

async function emit(dialog: HTMLElement, name = "Integración contable") {
  fireEvent.change(within(dialog).getByLabelText("Nombre del token"), {
    target: { value: name },
  });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Emitir token" }));
}

/** Everything a page could persist or expose besides the dialog itself. */
function expectSecretNowhere(client: Parameters<typeof serializeClient>[0]) {
  expect(serializeClient(client)).not.toContain(SENTINEL);
  expect(JSON.stringify({ ...window.localStorage })).not.toContain(SENTINEL);
  expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SENTINEL);
  expect(window.location.href).not.toContain(SENTINEL);
  expect(JSON.stringify(window.history.state)).not.toContain(SENTINEL);
  expect(JSON.stringify(consoleCalls)).not.toContain(SENTINEL);
}

describe("entry point (AC-12)", () => {
  it("lists «Tokens de API» in the sidebar for someone with a membership", async () => {
    setup();
    await open("/api-tokens");
    const link = screen.getByRole("link", { name: "Tokens de API" });
    expect(link.getAttribute("href")).toBe("/api-tokens");
  });

  it("hides it from a platform administrator without membership and explains the screen", async () => {
    setup({
      profile: () =>
        profileFixture({ isPlatformAdministrator: true, memberships: [] }),
    });
    await open("/api-tokens");
    expect(screen.queryByRole("link", { name: "Tokens de API" })).toBeNull();
    expect(
      screen.getByText(/Necesitas pertenecer a una organización/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir token" })).toBeNull();
  });

  it("explains a membership without invoice permissions and offers no emission", async () => {
    setup({
      profile: () =>
        profileFixture({ memberships: [membership(norte, "ADMIN")] }),
    });
    await open("/api-tokens");
    expect(screen.getByText(/No tienes permisos sobre facturas/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Emitir token" })).toBeNull();
  });
});

describe("token list (AC-12)", () => {
  it("shows own tokens with resolved scope names, permissions, dates and status", async () => {
    const now = Date.now();
    setup({
      tokens: [
        token(1, {
          name: "CI producción",
          scopes: ["invoices:read", "invoices:create"],
        }),
        token(2, {
          name: "Robot antiguo",
          groupId: contabilidad.id,
          scopes: ["invoices:delete-own"],
          expiresAt: new Date(now - DAY).toISOString(),
        }),
        token(3, {
          name: "Token filtrado",
          revokedAt: "2026-10-25T10:00:00.000Z",
        }),
      ],
    });
    await open();
    const table = await screen.findByRole("table", { name: /Tokens de API/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const [active, expired, revoked] = rows.map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent ?? ""),
    );
    expect(active[0]).toBe("CI producción");
    expect(active[1]).toBe("Toda la organización");
    expect(active[2]).toBe("Leer facturas, Crear facturas");
    expect(active[5]).toBe("Activo");
    expect(expired[1]).toBe("Grupo Contabilidad");
    expect(expired[2]).toBe("Eliminar facturas propias");
    expect(expired[5]).toBe("Vencido");
    expect(revoked[5]).toBe("Revocado");
    expect(
      within(rows[2]).queryByRole("button", { name: /Revocar/ }),
    ).toBeNull();
    expect(
      within(rows[0]).getByRole("button", {
        name: "Revocar token CI producción",
      }),
    ).toBeTruthy();
  });

  it("asks the API for the page in the URL and moves with Anterior / Siguiente", async () => {
    const { transport } = setup({
      tokens: Array.from({ length: 45 }, (_, n) => token(n + 1)),
    });
    await open("/api-tokens?page=2");
    await waitFor(() =>
      expect(
        transport
          .calls(`GET ${TOKENS}`)
          .map(({ search }) => new URLSearchParams(search).get("page")),
      ).toContain("2"),
    );
    expect(await screen.findByText("Página 2 de 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await waitFor(() => expect(window.location.search).toContain("page=3"));
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    await waitFor(() => expect(window.location.search).toContain("page=2"));
    await settled();
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    await screen.findByText("Página 1 de 3");
    await waitFor(() => expect(window.location.search).not.toContain("page="));
  });

  it("lists the tokens of the organization the person picks", async () => {
    const { transport } = setup({
      tokens: [
        token(1, { name: "Del norte" }),
        token(2, { name: "Del sur", organizationId: sur.id }),
      ],
    });
    await open();
    await screen.findByText("Del norte");
    fireEvent.change(screen.getByLabelText("Organización"), {
      target: { value: sur.id },
    });
    await screen.findByText("Del sur");
    expect(screen.queryByText("Del norte")).toBeNull();
    expect(
      transport
        .calls(`GET ${TOKENS}`)
        .some(({ search }) => search.includes(`organizationId=${sur.id}`)),
    ).toBe(true);
  });

  it("shows no rows of the previous organization and no false empty message while the next one loads (CR-318)", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({
      tokens: [token(1, { name: "Del norte" })],
    });
    const original = transport.routes[`GET ${TOKENS}`];
    transport.routes[`GET ${TOKENS}`] = (request) =>
      new URLSearchParams(request.search).get("organizationId") === sur.id
        ? gate.promise
        : original(request);
    await open();
    await screen.findByText("Del norte");
    fireEvent.change(screen.getByLabelText("Organización"), {
      target: { value: sur.id },
    });
    await waitFor(() =>
      expect(
        transport
          .calls(`GET ${TOKENS}`)
          .some(({ search }) => search.includes(`organizationId=${sur.id}`)),
      ).toBe(true),
    );
    expect(screen.queryByText("Del norte")).toBeNull();
    expect(screen.queryByRole("button", { name: /Revocar/ })).toBeNull();
    expect(screen.queryByText(/No tienes tokens en/)).toBeNull();
    expect(screen.getByText("Cargando tokens...")).toBeTruthy();

    await act(async () => {
      gate.resolve(
        jsonResponse({ items: [], page: 1, pageSize: 20, total: 0 }),
      );
    });
    expect(
      await screen.findByText(`No tienes tokens en ${sur.name}.`),
    ).toBeTruthy();
  });
});

describe("emission form (AC-12)", () => {
  it("offers scopes grouped per organization, only where the person has permissions", async () => {
    setup();
    await open();
    const dialog = await openForm();
    const select = within(dialog).getByLabelText("Alcance del token");
    const groups = [...select.querySelectorAll("optgroup")].map((group) => [
      group.label,
      [...group.querySelectorAll("option")].map((option) => option.textContent),
    ]);
    await waitFor(() =>
      expect(
        [...select.querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ).toContain("Finanzas"),
    );
    expect(groups.map(([label]) => label)).toEqual([norte.name, sur.name]);
    expect(
      [...select.querySelectorAll("optgroup")].map((group) =>
        [...group.querySelectorAll("option")].map(
          (option) => option.textContent,
        ),
      ),
    ).toEqual([
      ["Toda la organización", "Contabilidad", "Finanzas"],
      ["Compras"],
    ]);
  });

  it("limits permissions to the chosen scope and resets the ones it does not allow", async () => {
    setup();
    await open();
    const dialog = await openForm();
    const names = () =>
      within(dialog)
        .getAllByRole("checkbox")
        .map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);
    expect(names()).toEqual(["Leer facturas", "Crear facturas"]);

    const select = within(dialog).getByLabelText("Alcance del token");
    await within(dialog).findByRole("option", { name: "Contabilidad" });
    fireEvent.change(select, {
      target: { value: `group:${norte.id}:${contabilidad.id}` },
    });
    expect(names()).toEqual([
      "Leer facturas",
      "Crear facturas",
      "Eliminar facturas propias",
    ]);
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Eliminar facturas propias",
      }),
    );
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Crear facturas" }),
    );

    fireEvent.change(select, {
      target: { value: `group:${sur.id}:${compras.id}` },
    });
    expect(names()).toEqual(["Leer facturas"]);

    fireEvent.change(select, {
      target: { value: `group:${norte.id}:${contabilidad.id}` },
    });
    // Nothing the scope change dropped comes back checked.
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .map((box) => (box as HTMLInputElement).checked),
    ).toEqual([false, false, false]);
  });

  it("validates name and permissions accessibly before sending", async () => {
    const { transport } = setup();
    await open();
    const dialog = await openForm();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Emitir token" }),
    );
    const name = within(dialog).getByLabelText("Nombre del token");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(
      within(dialog).getByText("Escribe un nombre para el token."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Elige al menos un permiso.")).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(0);
  });

  it("rejects an expiry beyond 29 days on the client and accepts the 29th day", async () => {
    const { transport } = setup();
    await open();
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText("Nombre del token"), {
      target: { value: "Largo" },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
    );
    fireEvent.click(within(dialog).getByRole("radio", { name: "Otra fecha" }));
    const date = within(dialog).getByLabelText("Fecha de caducidad");
    fireEvent.change(date, {
      target: { value: civil(new Date(Date.now() + 30 * DAY)) },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Emitir token" }),
    );
    expect(
      within(dialog).getByText("La caducidad no puede superar los 29 días."),
    ).toBeTruthy();
    expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(0);

    fireEvent.change(date, {
      target: { value: civil(new Date(Date.now() + 29 * DAY)) },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Emitir token" }),
    );
    await screen.findByRole("dialog", { name: "Token emitido" });
    const [post] = transport.calls(`POST ${TOKENS}`);
    const remaining =
      Date.parse((post.body as { expiresAt: string }).expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(28 * DAY);
    expect(remaining).toBeLessThanOrEqual(29 * DAY);
  });

  it("shows the real expiry live, and the sent expiry is the shown one (CR-346)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 31, 12, 0, 0));
    try {
      const { transport } = setup();
      await open();
      const dialog = await openForm();
      const expiry = (text: string) => within(dialog).getByText(text);
      // The default is the longest preset: 29 days from now, with its hour.
      expiry(expiryText(new Date(2026, 10, 29, 12, 0, 0)));
      fireEvent.click(within(dialog).getByRole("radio", { name: "7 días" }));
      expiry(expiryText(new Date(2026, 10, 7, 12, 0, 0)));
      fireEvent.click(
        within(dialog).getByRole("radio", { name: "Otra fecha" }),
      );
      const date = within(dialog).getByLabelText(
        "Fecha de caducidad",
      ) as HTMLInputElement;
      // The picker stops at the same last day the copy promises.
      expect(date.max).toBe("2026-11-29");
      fireEvent.change(date, { target: { value: date.max } });
      expiry(expiryText(new Date(2026, 10, 29, 12, 0, 0)));
      fireEvent.change(within(dialog).getByLabelText("Nombre del token"), {
        target: { value: "Fecha" },
      });
      fireEvent.click(
        within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Emitir token" }),
      );
      await screen.findByRole("dialog", { name: "Token emitido" });
      const [post] = transport.calls(`POST ${TOKENS}`);
      expect((post.body as { expiresAt: string }).expiresAt).toBe(
        new Date(2026, 10, 29, 12, 0, 0).toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the server's expiry in the issued dialog (CR-346)", async () => {
    const expiresAt = new Date(2026, 10, 20, 18, 30, 0).toISOString();
    setup({
      create: () =>
        jsonResponse(
          {
            token: token(51, { name: "Con vencimiento", expiresAt }),
            secret: SENTINEL,
          },
          201,
        ),
    });
    await open();
    const dialog = await openForm();
    await emit(dialog, "Con vencimiento");
    const issued = await screen.findByRole("dialog", { name: "Token emitido" });
    expect(
      within(issued).getByText(expiryText(new Date(expiresAt))),
    ).toBeTruthy();
  });

  it("sends the chosen scope, name, permissions and a 29 day default expiry", async () => {
    const { transport } = setup();
    await open();
    const dialog = await openForm();
    await within(dialog).findByRole("option", { name: "Contabilidad" });
    fireEvent.change(within(dialog).getByLabelText("Alcance del token"), {
      target: { value: `group:${norte.id}:${contabilidad.id}` },
    });
    fireEvent.change(within(dialog).getByLabelText("Nombre del token"), {
      target: { value: "  Robot de conciliación  " },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
    );
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Eliminar facturas propias",
      }),
    );
    expect(
      (
        within(dialog).getByRole("radio", {
          name: "29 días",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Emitir token" }),
    );
    await screen.findByRole("dialog", { name: "Token emitido" });
    const [post] = transport.calls(`POST ${TOKENS}`);
    expect(post.body).toMatchObject({
      name: "Robot de conciliación",
      organizationId: norte.id,
      groupId: contabilidad.id,
      scopes: ["invoices:read", "invoices:delete-own"],
    });
    const remaining =
      Date.parse((post.body as { expiresAt: string }).expiresAt) - Date.now();
    expect(remaining).toBeGreaterThan(28 * DAY);
    expect(remaining).toBeLessThanOrEqual(29 * DAY);
  });
});

describe("a submit in flight (CR-323, CR-328)", () => {
  it("sends exactly one request for a double submit in the same tick", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ create: () => gate.promise });
    await open();
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText("Nombre del token"), {
      target: { value: "Doble" },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
    );
    const form = dialog.querySelector("form") as HTMLFormElement;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() =>
      expect(transport.calls(`POST ${TOKENS}`).length).toBeGreaterThan(0),
    );
    await act(async () => {
      gate.resolve(jsonResponse({ token: token(50), secret: SENTINEL }, 201));
    });
    await screen.findByRole("dialog", { name: "Token emitido" });
    expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(1);
  });

  it("keeps focus on the field while pending: controls are read-only, not disabled", async () => {
    const gate = deferred<Response>();
    setup({ create: () => gate.promise });
    await open();
    const dialog = await openForm();
    const name = within(dialog).getByLabelText(
      "Nombre del token",
    ) as HTMLInputElement;
    name.focus();
    fireEvent.change(name, { target: { value: "Integración" } });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
    );
    name.focus();
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    await within(dialog).findByText("Emitiendo token…");
    expect(document.activeElement).toBe(name);
    expect(name.readOnly).toBe(true);
    expect(name.disabled).toBe(false);
    const scope = within(dialog).getByLabelText("Alcance del token");
    expect(scope.getAttribute("aria-disabled")).toBe("true");
    const box = within(dialog).getByRole("checkbox", {
      name: "Leer facturas",
    }) as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(box.getAttribute("aria-disabled")).toBe("true");
    // A change while pending is ignored.
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.change(name, { target: { value: "Otro nombre" } });
    expect(name.value).toBe("Integración");
    await act(async () => {
      gate.resolve(jsonResponse({ token: token(50), secret: SENTINEL }, 201));
    });
  });

  it("moves focus to the alert when the emission fails", async () => {
    setup({ create: () => errorResponse(503, "SERVICE_UNAVAILABLE") });
    await open();
    const dialog = await openForm();
    const name = within(dialog).getByLabelText("Nombre del token");
    fireEvent.change(name, { target: { value: "Integración" } });
    fireEvent.click(
      within(dialog).getByRole("checkbox", { name: "Leer facturas" }),
    );
    name.focus();
    fireEvent.submit(dialog.querySelector("form") as HTMLFormElement);
    const alert = await within(dialog).findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("the secret is shown once and never cached (AC-13)", () => {
  it("shows the secret only in its dialog and leaves it in no cache, storage, URL, history or log", async () => {
    const { store } = setup();
    const view = await open("/api-tokens", true);
    const dialog = await openForm();
    await emit(dialog);
    const secretDialog = await screen.findByRole("dialog", {
      name: "Token emitido",
    });

    const field = within(secretDialog).getByLabelText(
      "Token de acceso",
    ) as HTMLInputElement;
    expect(field.value).toBe(SENTINEL);
    expect(field.readOnly).toBe(true);
    expect(
      within(secretDialog).getByText(
        "No podrás volver a verlo. Cópialo y guárdalo en un lugar seguro.",
      ),
    ).toBeTruthy();
    expect(
      within(secretDialog).getByText(/portapapeles del sistema/),
    ).toBeTruthy();
    // Emission is not a clipboard action: nothing was copied by itself.
    expect(Object.hasOwn(navigator, "clipboard")).toBe(false);

    const client = view.store.getSnapshot().client;
    expectSecretNowhere(client);
    const mutations = client.getMutationCache().getAll();
    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.state.variables)).not.toContain(SENTINEL);
      expect(JSON.stringify(mutation.state.data)).not.toContain(SENTINEL);
    }
    expect(store.tokens).toHaveLength(1);

    // Closing drops it for good, from the page and from the next dialog.
    fireEvent.click(
      within(secretDialog).getByRole("button", { name: "Ya guardé el token" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Token emitido" }),
      ).toBeNull(),
    );
    expect(document.body.innerHTML).not.toContain(SENTINEL);
    expect((document.activeElement as HTMLElement).textContent).toBe(
      "Emitir token",
    );
    expectSecretNowhere(client);

    // The list shows the token by metadata only, and a reopened form is empty.
    await screen.findByText("Integración contable");
    const again = await openForm();
    expect(
      (within(again).getByLabelText("Nombre del token") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  it("refreshes the list through metadata after emission", async () => {
    const { transport } = setup();
    await open();
    const before = transport.calls(`GET ${TOKENS}`).length;
    const dialog = await openForm();
    await emit(dialog, "Nuevo token");
    await screen.findByRole("dialog", { name: "Token emitido" });
    await waitFor(() =>
      expect(transport.calls(`GET ${TOKENS}`).length).toBeGreaterThan(before),
    );
    expect((await screen.findAllByText("Nuevo token")).length).toBeGreaterThan(
      0,
    );
  });

  it("does not deliver the secret when the form was closed before the answer", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ create: () => gate.promise });
    const view = await open();
    const dialog = await openForm();
    await emit(dialog);
    await waitFor(() =>
      expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(1),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Emitir token" })).toBeNull(),
    );

    const listCalls = transport.calls(`GET ${TOKENS}`).length;
    await act(async () => {
      gate.resolve(jsonResponse({ token: token(50), secret: SENTINEL }, 201));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.innerHTML).not.toContain(SENTINEL);
    expectSecretNowhere(view.store.getSnapshot().client);

    // The person learns a token exists that they never saw (CR-329).
    expect(
      await screen.findByText(
        "Se emitió un token en Academia Norte que no alcanzaste a ver. Revócalo desde la lista si no lo vas a usar.",
      ),
    ).toBeTruthy();
    // CR-349: a warning (not a success), kept until dismissed, in the page
    // flow so it cannot cover the paginator.
    const card = document.querySelector(".toast");
    expect(card?.classList.contains("is-warning")).toBe(true);
    expect(card?.querySelector(".lucide-triangle-alert")).not.toBeNull();
    expect(card?.querySelector(".lucide-circle-check")).toBeNull();
    expect(document.querySelector(".toast-region.is-inline")).not.toBeNull();
    await waitFor(() =>
      expect(transport.calls(`GET ${TOKENS}`).length).toBeGreaterThan(
        listCalls,
      ),
    );
    expect(document.body.innerHTML).not.toContain(SENTINEL);
  });

  it("shows no notice when the form was closed and the emission failed", async () => {
    const gate = deferred<Response>();
    const { transport } = setup({ create: () => gate.promise });
    await open();
    const dialog = await openForm();
    await emit(dialog);
    await waitFor(() =>
      expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(1),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await act(async () => {
      gate.resolve(errorResponse(503, "SERVICE_UNAVAILABLE"));
    });
    expect(screen.queryByText(/no alcanzaste a ver/)).toBeNull();
  });

  it("does not show a late secret after logout or for the next identity", async () => {
    const gate = deferred<Response>();
    let signedIn: "ada" | "bruno" = "ada";
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile:
            signedIn === "ada"
              ? me()
              : profileFixture({
                  id: uuid(2),
                  name: "Bruno Díaz",
                  rut: "111111111",
                  memberships: [],
                }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      [ORG_GROUPS]: () => groupsOf(contabilidad),
      [`GET ${TOKENS}`]: () =>
        jsonResponse({ items: [], page: 1, pageSize: 20, total: 0 }),
      [`POST ${TOKENS}`]: () => gate.promise,
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/login": () => {
        signedIn = "bruno";
        return jsonResponse({ user: {} });
      },
    });
    const view = await open();
    const clientOfAda = view.store.getSnapshot().client;
    const dialog = await openForm();
    await emit(dialog);
    await waitFor(() =>
      expect(transport.calls(`POST ${TOKENS}`)).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    await act(async () => {
      gate.resolve(jsonResponse({ token: token(50), secret: SENTINEL }, 201));
    });
    expect(document.body.innerHTML).not.toContain(SENTINEL);

    // The next identity never receives it either.
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "111111111" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "another-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Bruno Díaz/);
    expect(document.body.innerHTML).not.toContain(SENTINEL);
    expect(screen.queryByRole("dialog")).toBeNull();
    expectSecretNowhere(view.store.getSnapshot().client);
    expectSecretNowhere(clientOfAda);
  });
});

describe("copying (AC-14)", () => {
  it("copies only on click, announces «Copiado» and keeps the dialog open", async () => {
    setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await open();
    await emit(await openForm());
    const dialog = await screen.findByRole("dialog", { name: "Token emitido" });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SENTINEL));
    expect(writeText).toHaveBeenCalledTimes(1);
    const status = await within(dialog).findByText("Copiado");
    expect(status.closest("[aria-live]")?.getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it("tells the person to copy by hand when the clipboard is denied", async () => {
    setup();
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const view = await open();
    await emit(await openForm());
    const dialog = await screen.findByRole("dialog", { name: "Token emitido" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar" }));
    expect(
      await within(dialog).findByText(
        /Selecciona el token y cópialo manualmente/,
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText("Copiado")).toBeNull();
    expectSecretNowhere(view.store.getSnapshot().client);
  });

  it("falls back to the manual message when there is no clipboard API", async () => {
    setup();
    await open();
    await emit(await openForm());
    const dialog = await screen.findByRole("dialog", { name: "Token emitido" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Copiar" }));
    expect(
      await within(dialog).findByText(
        /Selecciona el token y cópialo manualmente/,
      ),
    ).toBeTruthy();
  });
});

describe("revocation (AC-12)", () => {
  it("asks first, returns focus on cancel and shows «Revocado» after confirming", async () => {
    const { transport } = setup({
      tokens: [token(1, { name: "CI producción" })],
    });
    await open();
    const trigger = await screen.findByRole("button", {
      name: "Revocar token CI producción",
    });
    trigger.focus();
    fireEvent.click(trigger);
    let dialog = await screen.findByRole("dialog", { name: "Revocar token" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText(/CI producción/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(transport.calls(`DELETE ${TOKENS}/${uuid(901)}`)).toHaveLength(0);

    fireEvent.click(trigger);
    dialog = await screen.findByRole("dialog", { name: "Revocar token" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Revocar token" }),
    );
    await waitFor(() =>
      expect(transport.calls(`DELETE ${TOKENS}/${uuid(901)}`)).toHaveLength(1),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const row = (await screen.findByText("CI producción")).closest(
      "tr",
    ) as HTMLElement;
    await waitFor(() => expect(within(row).getByText("Revocado")).toBeTruthy());
    expect(within(row).queryByRole("button", { name: /Revocar/ })).toBeNull();
    expect(screen.getByText("Token revocado.")).toBeTruthy();
  });

  it("explains a failed revocation in Spanish and keeps the dialog open", async () => {
    const { transport } = setup({ tokens: [token(1)] });
    transport.routes[`DELETE ${TOKENS}/${uuid(901)}`] = () =>
      errorResponse(404, "NOT_FOUND");
    await open();
    fireEvent.click(
      await screen.findByRole("button", { name: "Revocar token Token 1" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Revocar token" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Revocar token" }),
    );
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(/ya no existe|no se encontró/i);
    expect(alert.textContent).not.toContain("server");
  });
});

describe("failures (AC-12)", () => {
  it.each([
    [400, "VALIDATION_ERROR", /Revisa los datos/],
    [403, "FORBIDDEN", /ya no tienes permiso/i],
    [404, "NOT_FOUND", /organización o el grupo/],
    [503, "SERVICE_UNAVAILABLE", /ocupado|no disponible/i],
    [409, "TOKEN_LIMIT", /máximo de 50 tokens activos en esta organización/],
    [429, "RATE_LIMITED", /demasiados tokens seguidos/],
  ])(
    "explains a %s in Spanish without raw JSON",
    async (status, code, expected) => {
      setup({ create: () => errorResponse(status, code) });
      const view = await open();
      const dialog = await openForm();
      await emit(dialog);
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toMatch(expected);
      expect(alert.textContent).not.toMatch(/server|\{|code/);
      // The dialog stays editable and no secret exists.
      expect(
        screen.queryByRole("dialog", { name: "Token emitido" }),
      ).toBeNull();
      expectSecretNowhere(view.store.getSnapshot().client);
    },
  );
});

describe("a refused expiry (CR-320)", () => {
  it("explains it on the expiry field instead of a generic alert", async () => {
    setup({
      create: () =>
        errorResponse(400, "VALIDATION_ERROR", {
          expiresAt:
            "expiresAt must be in the future and at most 30 days ahead",
        }),
    });
    await open();
    const dialog = await openForm();
    await emit(dialog);
    const message = await within(dialog).findByText(
      "La caducidad debe ser futura y de máximo 29 días.",
    );
    const fieldset = message.closest("fieldset") as HTMLElement;
    expect(fieldset.getAttribute("aria-describedby")?.split(" ")).toContain(
      message.id,
    );
    expect(within(dialog).queryByRole("alert")).toBeNull();

    // Changing the expiry clears the message.
    fireEvent.click(within(dialog).getByRole("radio", { name: "7 días" }));
    expect(
      within(dialog).queryByText(
        "La caducidad debe ser futura y de máximo 29 días.",
      ),
    ).toBeNull();
  });
});
