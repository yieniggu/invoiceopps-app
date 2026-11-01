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
  groupsOf,
  invoice,
  invoicePage,
  ME,
  norte,
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
  type RouteHandler,
} from "../../test/transport";
import { groupInvoicesKey, orgInvoicesKey } from "../auth/session/queryKeys";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CREATE = { ...NO_PERMISSIONS, createInvoices: true };
const CREATE_READ = { ...CREATE, readInvoices: true };
const CREATE_URL = "POST /api/v1/invoices";
const ORG_GROUPS = `GET /api/v1/organizations/${norte.id}/groups`;
const KEY_FORMAT = /^[A-Za-z0-9_-]{16,128}$/;

/** Organization-wide creator (and reader or not) that is also in Contabilidad. */
const creator = (read = false) =>
  profileFixture({
    memberships: [
      membership(norte, "USER", {
        permissions: read ? CREATE_READ : CREATE,
        groups: [
          { group: contabilidad, effective: read ? CREATE_READ : CREATE },
        ],
      }),
    ],
  });

function createTransport(
  profile: () => Record<string, unknown>,
  create: RouteHandler,
  extra: Record<string, RouteHandler> = {},
) {
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: profile() }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [ORG_GROUPS]: () => groupsOf(contabilidad, finanzas),
    "GET /api/v1/invoices": () => invoicePage([]),
    [CREATE_URL]: create,
    ...extra,
  });
}

const created = (overrides: Record<string, unknown> = {}) =>
  jsonResponse({ invoice: invoice(1, overrides) }, 201);

/** POST /invoices requests as sent: key header plus parsed body. */
const posts = (transport: ReturnType<typeof mockTransport>) =>
  transport.fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input) === "/api/v1/invoices" && init?.method === "POST",
    )
    .map(([, init]) => ({
      key: new Headers(init?.headers).get("Idempotency-Key"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }));

const set = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function fillForm(
  overrides: Partial<Record<"id" | "supplier" | "amount", string>> = {},
) {
  await screen.findByLabelText("Número de factura");
  set("Número de factura", overrides.id ?? "FAC-2026-001");
  set("Proveedor", overrides.supplier ?? "Proveedor local");
  set("Monto en pesos (CLP)", overrides.amount ?? "12.500");
  set("Fecha de emisión", "2026-10-25");
  set("Fecha de vencimiento", "2026-11-25");
}

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Crear factura" }));

const openForm = async (route = "/invoices/new") => {
  const view = renderApp({ route });
  await screen.findByLabelText("Número de factura");
  return view;
};

describe("entry point (AC-01)", () => {
  it("shows «Nueva factura» in the inbox only to someone who can create", async () => {
    createTransport(creator, () => created());
    renderApp({ route: "/invoices" });
    const link = await screen.findByRole("link", { name: "Nueva factura" });
    expect(link.getAttribute("href")).toBe("/invoices/new");
  });

  it("does not show it to a reader without create", async () => {
    createTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", {
              permissions: { ...NO_PERMISSIONS, readInvoices: true },
            }),
          ],
        }),
      () => created(),
    );
    renderApp({ route: "/invoices" });
    await screen.findByLabelText("Ver facturas de");
    expect(screen.queryByRole("link", { name: "Nueva factura" })).toBeNull();
  });

  it("explains the missing permission on a direct visit", async () => {
    createTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", {
              permissions: { ...NO_PERMISSIONS, readInvoices: true },
            }),
          ],
        }),
      () => created(),
    );
    renderApp({ route: "/invoices/new" });
    expect(
      await screen.findByText(/No tienes permiso para crear facturas/),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Número de factura")).toBeNull();
  });
});

describe("scope selector (AC-03)", () => {
  it("offers only scopes where create is effective, grouped per organization", async () => {
    createTransport(
      () =>
        profileFixture({
          memberships: [
            membership(norte, "USER", {
              groups: [
                { group: contabilidad, effective: CREATE },
                { group: compras, effective: { ...NO_PERMISSIONS } },
              ],
            }),
            membership(sur, "USER", { permissions: CREATE }),
          ],
        }),
      () => created(),
      {
        [`GET /api/v1/organizations/${sur.id}/groups`]: () =>
          jsonResponse({ groups: [] }),
      },
    );
    await openForm();
    const select = screen.getByLabelText("Alcance de la factura");
    expect(
      within(select)
        .getAllByRole("group")
        .map((group) => [
          group.getAttribute("label"),
          within(group)
            .getAllByRole("option")
            .map((option) => option.textContent),
        ]),
    ).toEqual([
      ["Academia Norte", ["Contabilidad"]],
      ["Instituto Sur", ["Organización (sin grupo)"]],
    ]);
  });

  it("adds the groups the organization lists to an organization-wide creator", async () => {
    createTransport(creator, () => created());
    await openForm();
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Alcance de la factura"))
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(["Organización (sin grupo)", "Contabilidad", "Finanzas"]),
    );
  });
});

describe("creating an invoice (AC-01, AC-02)", () => {
  it("creates 12500 pesos in the organization scope without a groupId", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    await fillForm();
    submit();
    expect(
      await screen.findByRole("heading", { name: "Factura creada" }),
    ).toBeTruthy();
    const [request, ...rest] = posts(transport);
    expect(rest).toEqual([]);
    expect(request.key).toMatch(KEY_FORMAT);
    expect(request.body).toEqual({
      organizationId: norte.id,
      businessId: "FAC-2026-001",
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
    });
    expect(Object.hasOwn(request.body, "groupId")).toBe(false);
  });

  it("creates in a group scope sending that groupId", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    await fillForm({ amount: "12500" });
    set("Alcance de la factura", `group:${norte.id}:${contabilidad.id}`);
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(posts(transport)[0].body).toMatchObject({
      organizationId: norte.id,
      groupId: contabilidad.id,
      amountPesos: 12500,
    });
  });

  it("never sends a residual groupId after switching back to the organization", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    await fillForm();
    set("Alcance de la factura", `group:${norte.id}:${contabilidad.id}`);
    set("Alcance de la factura", `organization:${norte.id}`);
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(Object.hasOwn(posts(transport)[0].body, "groupId")).toBe(false);
  });

  it("sends one request on a double click and shows the pending state", async () => {
    const response = deferred<Response>();
    const transport = createTransport(creator, () => response.promise);
    await openForm();
    await fillForm();
    const button = screen.getByRole("button", { name: "Crear factura" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.submit(button.closest("form")!);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Creando factura…" }),
      ).toBeTruthy(),
    );
    expect(
      screen
        .getByRole("button", { name: "Creando factura…" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(posts(transport)).toHaveLength(1);
    await act(async () => response.resolve(created()));
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(posts(transport)).toHaveLength(1);
  });

  it("starts a fresh attempt with a new key on «Crear otra»", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    fireEvent.click(screen.getByRole("button", { name: "Crear otra" }));
    await fillForm({ id: "FAC-2026-002" });
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).not.toBe(first.key);
    expect(second.body.businessId).toBe("FAC-2026-002");
  });

  it("does not generate the key before the first submit", async () => {
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    createTransport(creator, () => created());
    await openForm();
    await fillForm();
    expect(uuid).not.toHaveBeenCalled();
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(uuid).toHaveBeenCalledTimes(1);
  });
});

describe("uncertain attempts (AC-02)", () => {
  const offline = () => {
    throw new TypeError("Failed to fetch");
  };

  it("retries with the same key and payload after a network failure", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      if (calls === 1) return offline();
      return created();
    });
    await openForm();
    await fillForm();
    submit();
    expect(
      await screen.findByText(/no sabemos si la factura se creó/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(first.key).toMatch(KEY_FORMAT);
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual(first.body);
  });

  it("treats a timeout like a network failure and keeps the key", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      if (calls === 1)
        throw new DOMException("The operation timed out.", "TimeoutError");
      return created();
    });
    await openForm();
    await fillForm();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).toBe(first.key);
  });

  it("retries a 503 with the same key", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1 ? errorResponse(503, "RETRYABLE_CONFLICT") : created();
    });
    await openForm();
    await fillForm();
    submit();
    expect(await screen.findByText(/El sistema está ocupado/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).toBe(first.key);
  });

  it("asks to confirm a new operation when the data change after an uncertain attempt", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1 ? offline() : created();
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("button", { name: "Reintentar" });
    set("Monto en pesos (CLP)", "13.000");
    submit();
    expect(
      await screen.findByRole("button", {
        name: "Crear como operación nueva",
      }),
    ).toBeTruthy();
    expect(posts(transport)).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Crear como operación nueva" }),
    );
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).toMatch(KEY_FORMAT);
    expect(second.key).not.toBe(first.key);
    expect(second.body.amountPesos).toBe(13000);
  });

  it("asks for the same confirmation when only the scope changes", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1 ? offline() : created();
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("button", { name: "Reintentar" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Contabilidad" })).toBeTruthy(),
    );
    set("Alcance de la factura", `group:${norte.id}:${contabilidad.id}`);
    submit();
    await screen.findByRole("button", { name: "Crear como operación nueva" });
    expect(posts(transport)).toHaveLength(1);
  });

  it("keeps the uncertain key when the confirmation is refused by validation (CR-327)", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1 ? offline() : created();
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("button", { name: "Reintentar" });
    set("Monto en pesos (CLP)", "13.000");
    submit();
    const confirm = await screen.findByRole("button", {
      name: "Crear como operación nueva",
    });
    // Invalid data: confirming must not spend the uncertain attempt.
    set("Monto en pesos (CLP)", "abc");
    fireEvent.click(confirm);
    expect(
      await screen.findByText(/Ingresa el monto solo con números/),
    ).toBeTruthy();
    expect(posts(transport)).toHaveLength(1);

    // Back to the original data: the original key is reused, never a new one.
    set("Monto en pesos (CLP)", "12.500");
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).toBe(first.key);
    expect(second.body).toEqual(first.body);
  });

  it("lets the person dismiss the confirmation without sending anything", async () => {
    const transport = createTransport(creator, offline);
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("button", { name: "Reintentar" });
    set("Proveedor", "Otro proveedor");
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(
      screen.queryByRole("button", { name: "Crear como operación nueva" }),
    ).toBeNull();
    expect(posts(transport)).toHaveLength(1);
  });
});

describe("focus around a request (CR-328)", () => {
  it("keeps focus on the field while the request is out: read-only, not disabled", async () => {
    const response = deferred<Response>();
    createTransport(creator, () => response.promise);
    await openForm();
    await fillForm();
    const supplier = screen.getByLabelText("Proveedor") as HTMLInputElement;
    supplier.focus();
    fireEvent.submit(supplier.closest("form")!);
    await screen.findByRole("button", { name: "Creando factura…" });
    expect(document.activeElement).toBe(supplier);
    expect(supplier.readOnly).toBe(true);
    expect(supplier.disabled).toBe(false);
    const scope = screen.getByLabelText("Alcance de la factura");
    expect(scope.getAttribute("aria-disabled")).toBe("true");
    // A change while pending is ignored.
    fireEvent.change(supplier, { target: { value: "Otro" } });
    expect(supplier.value).toBe("Proveedor local");
    await act(async () => response.resolve(created()));
    await screen.findByRole("heading", { name: "Factura creada" });
  });

  it("moves focus to «Reintentar» after an uncertain failure", async () => {
    createTransport(creator, () => {
      throw new TypeError("Failed to fetch");
    });
    await openForm();
    await fillForm();
    screen.getByLabelText("Proveedor").focus();
    submit();
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });

  it("moves focus to the alert after a failure without retry", async () => {
    createTransport(creator, () => errorResponse(400, "VALIDATION_ERROR"));
    await openForm();
    await fillForm();
    screen.getByLabelText("Proveedor").focus();
    submit();
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("keeps «Reintentar» mounted and focused while the retry is out, then lands on the result (CR-328)", async () => {
    const response = deferred<Response>();
    let calls = 0;
    createTransport(creator, () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return response.promise;
    });
    await openForm();
    await fillForm();
    submit();
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toBe(2));
    // Pending: the very same button is still there, inert but focused.
    expect(screen.getByRole("button", { name: "Reintentar" })).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    // A second activation while pending sends nothing.
    fireEvent.click(retry);
    expect(calls).toBe(2);
    await act(async () => response.resolve(created()));
    const heading = await screen.findByRole("heading", {
      name: "Factura creada",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("lands on the alert when the retry fails for good (CR-328)", async () => {
    const response = deferred<Response>();
    let calls = 0;
    createTransport(creator, () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return response.promise;
    });
    await openForm();
    await fillForm();
    submit();
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(calls).toBe(2));
    expect(document.activeElement).toBe(retry);
    await act(async () =>
      response.resolve(errorResponse(400, "VALIDATION_ERROR")),
    );
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("keeps «Crear como operación nueva» mounted and focused while it is sent (CR-328)", async () => {
    const response = deferred<Response>();
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return response.promise;
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("button", { name: "Reintentar" });
    set("Monto en pesos (CLP)", "13.000");
    submit();
    const confirm = await screen.findByRole("button", {
      name: "Crear como operación nueva",
    });
    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls).toBe(2));
    expect(
      screen.getByRole("button", { name: "Crear como operación nueva" }),
    ).toBe(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    expect(posts(transport)).toHaveLength(2);
    await act(async () => response.resolve(created()));
    const heading = await screen.findByRole("heading", {
      name: "Factura creada",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});

describe("validation and accessibility (AC-05)", () => {
  it("focuses the first invalid field and links its message", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    submit();
    const businessId = screen.getByLabelText("Número de factura");
    await waitFor(() => expect(document.activeElement).toBe(businessId));
    expect(businessId.getAttribute("aria-invalid")).toBe("true");
    const message = document.getElementById(
      businessId.getAttribute("aria-describedby")!.split(" ")[0],
    );
    expect(message?.textContent).toMatch(/número de la factura/i);
    expect(posts(transport)).toEqual([]);
  });

  it("validates each field in order and clears the flag once fixed", async () => {
    createTransport(creator, () => created());
    await openForm();
    set("Número de factura", "FAC-1");
    submit();
    expect(document.activeElement).toBe(screen.getByLabelText("Proveedor"));
    set("Proveedor", "Proveedor local");
    set("Monto en pesos (CLP)", "12,5");
    submit();
    const amount = screen.getByLabelText("Monto en pesos (CLP)");
    expect(document.activeElement).toBe(amount);
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(
        amount.getAttribute("aria-describedby")!.split(" ")[0],
      )?.textContent,
    ).toMatch(/decimales/);
    set("Monto en pesos (CLP)", "12.500");
    expect(amount.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("rejects a due date earlier than the issue date", async () => {
    const transport = createTransport(creator, () => created());
    await openForm();
    await fillForm();
    set("Fecha de vencimiento", "2026-10-01");
    submit();
    const due = screen.getByLabelText("Fecha de vencimiento");
    expect(document.activeElement).toBe(due);
    expect(
      document.getElementById(due.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toMatch(/anterior a la fecha de emisión/);
    expect(posts(transport)).toEqual([]);
  });

  it("announces the form status in a live region", async () => {
    createTransport(creator, () => created());
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(screen.getByRole("status").textContent).toMatch(/Factura creada/);
  });
});

describe("error messages (AC-05)", () => {
  const offline = () => {
    throw new TypeError("Failed to fetch");
  };
  const timedOut = () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  type Outcome = "retry" | "confirm" | "neither";
  // What each failure offers: «Reintentar» only while the same request may be
  // repeated, «Crear como operación nueva» only once the key is spent, and
  // nothing when the API refused the request for good.
  it.each<[string, () => Response, RegExp, Outcome]>([
    [
      "400",
      () => errorResponse(400, "VALIDATION_ERROR"),
      /Algún dato de la factura no es válido/,
      "neither",
    ],
    [
      "403",
      () => errorResponse(403, "FORBIDDEN"),
      /No tienes permiso para crear facturas en este alcance/,
      "neither",
    ],
    [
      "404",
      () => errorResponse(404, "NOT_FOUND"),
      /No encontramos la organización o el grupo/,
      "neither",
    ],
    [
      "409 BUSINESS_ID_CONFLICT",
      () => errorResponse(409, "BUSINESS_ID_CONFLICT"),
      /Ya existe una factura con ese número/,
      "neither",
    ],
    [
      "409 IDEMPOTENCY_CONFLICT",
      () => errorResponse(409, "IDEMPOTENCY_CONFLICT"),
      /ya se había usado con datos distintos/,
      "confirm",
    ],
    [
      "410 INVOICE_DELETED",
      () => errorResponse(410, "INVOICE_DELETED"),
      /fue eliminada/,
      "confirm",
    ],
    [
      "503 RETRYABLE_CONFLICT",
      () => errorResponse(503, "RETRYABLE_CONFLICT"),
      /El sistema está ocupado/,
      "retry",
    ],
    [
      "500",
      () => errorResponse(500, "INTERNAL_ERROR"),
      /Ocurrió un error inesperado/,
      "retry",
    ],
    [
      "network failure",
      offline as () => Response,
      /No recibimos respuesta/,
      "retry",
    ],
    ["timeout", timedOut as () => Response, /No recibimos respuesta/, "retry"],
  ])(
    "explains a %s in Spanish and offers what fits",
    async (_name, respond, expected, outcome) => {
      createTransport(creator, respond);
      await openForm();
      await fillForm();
      submit();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(expected);
      expect(document.body.textContent).not.toMatch(/server |stack|\{"/i);
      const retry = screen.queryByRole("button", { name: "Reintentar" });
      const confirm = screen.queryByRole("button", {
        name: "Crear como operación nueva",
      });
      expect(retry !== null).toBe(outcome === "retry");
      expect(confirm !== null).toBe(outcome === "confirm");
    },
  );

  it("drops «Reintentar» when the retry is refused for good (uncertain, then 400)", async () => {
    let calls = 0;
    createTransport(creator, () => {
      calls += 1;
      return calls === 1
        ? errorResponse(503, "RETRYABLE_CONFLICT")
        : errorResponse(400, "VALIDATION_ERROR");
    });
    await openForm();
    await fillForm();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /Algún dato de la factura no es válido/,
      ),
    );
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Crear como operación nueva" }),
    ).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });

  it("asks for confirmation, focused, when the retry finds the key spent (uncertain, then 409)", async () => {
    let calls = 0;
    createTransport(creator, () => {
      calls += 1;
      return calls === 1
        ? errorResponse(503, "RETRYABLE_CONFLICT")
        : errorResponse(409, "IDEMPOTENCY_CONFLICT");
    });
    await openForm();
    await fillForm();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));
    await screen.findByRole("button", { name: "Crear como operación nueva" });
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
    const group = screen.getByRole("group", { name: "Operación nueva" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(group).getByText(/Esto se enviará como una operación nueva/),
      ),
    );
  });

  it("moves focus back to the confirmation when a confirmed operation is refused again", async () => {
    createTransport(creator, () => errorResponse(409, "IDEMPOTENCY_CONFLICT"));
    await openForm();
    await fillForm();
    submit();
    const confirm = await screen.findByRole("button", {
      name: "Crear como operación nueva",
    });
    const group = screen.getByRole("group", { name: "Operación nueva" });
    const text = within(group).getByText(/Esto se enviará como una operación/);
    await waitFor(() => expect(document.activeElement).toBe(text));
    confirm.focus();
    fireEvent.click(confirm);
    // The second burned answer arrives while the confirmation is still shown:
    // the message that explains it takes focus again.
    await waitFor(() => expect(document.activeElement).toBe(text));
  });

  it("requires confirming a new operation after an idempotency conflict, even unchanged", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1
        ? errorResponse(409, "IDEMPOTENCY_CONFLICT")
        : created();
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("alert");
    submit();
    fireEvent.click(
      await screen.findByRole("button", { name: "Crear como operación nueva" }),
    );
    await screen.findByRole("heading", { name: "Factura creada" });
    const [first, second] = posts(transport);
    expect(second.key).not.toBe(first.key);
  });

  it("uses a new key without asking after a definitive rejection", async () => {
    let calls = 0;
    const transport = createTransport(creator, () => {
      calls += 1;
      return calls === 1
        ? errorResponse(409, "BUSINESS_ID_CONFLICT")
        : created();
    });
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("alert");
    set("Número de factura", "FAC-2026-777");
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(posts(transport)[1].key).not.toBe(posts(transport)[0].key);
  });
});

describe("after success (AC-04)", () => {
  it("succeeds for a creator who cannot read, without any read request or link", async () => {
    const transport = createTransport(
      () => creator(false),
      () => created(),
    );
    await openForm();
    await fillForm();
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("link", { name: "Ver factura" })).toBeNull();
    expect(transport.calls("GET /api/v1/invoices")).toHaveLength(0);
    expect(window.location.pathname).toBe("/invoices/new");
  });

  it("offers «Ver factura» to a creator who can read the scope", async () => {
    createTransport(
      () => creator(true),
      () => created({ groupId: null }),
    );
    await openForm();
    await fillForm();
    submit();
    const link = await screen.findByRole("link", { name: "Ver factura" });
    expect(link.getAttribute("href")).toBe(
      `/invoices/${invoice(1).id}?organizationId=${norte.id}`,
    );
  });

  it("invalidates only the lists the group invoice belongs to", async () => {
    createTransport(
      () => creator(true),
      () => created({ groupId: contabilidad.id }),
    );
    const { store } = await openForm();
    const client = store.getSnapshot().client;
    const whole = orgInvoicesKey(ME, norte.id, { page: 1 });
    const ungrouped = orgInvoicesKey(ME, norte.id, {
      page: 1,
      ungrouped: true,
    });
    const ownGroup = groupInvoicesKey(ME, norte.id, contabilidad.id, {
      page: 1,
    });
    const otherGroup = groupInvoicesKey(ME, norte.id, compras.id, { page: 1 });
    const otherOrg = orgInvoicesKey(ME, sur.id, { page: 1 });
    for (const key of [whole, ungrouped, ownGroup, otherGroup, otherOrg])
      client.setQueryData(key, { items: [] });

    await fillForm();
    set("Alcance de la factura", `group:${norte.id}:${contabilidad.id}`);
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });

    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated;
    expect(stale(ownGroup)).toBe(true);
    expect(stale(whole)).toBe(true);
    expect(stale(ungrouped)).toBe(false);
    expect(stale(otherGroup)).toBe(false);
    expect(stale(otherOrg)).toBe(false);
  });

  it("invalidates the organization lists (and no group list) for an organization invoice", async () => {
    createTransport(
      () => creator(true),
      () => created(),
    );
    const { store } = await openForm();
    const client = store.getSnapshot().client;
    const whole = orgInvoicesKey(ME, norte.id, { page: 1 });
    const ungrouped = orgInvoicesKey(ME, norte.id, {
      page: 1,
      ungrouped: true,
    });
    const group = groupInvoicesKey(ME, norte.id, contabilidad.id, { page: 1 });
    for (const key of [whole, ungrouped, group])
      client.setQueryData(key, { items: [] });

    await fillForm();
    submit();
    await screen.findByRole("heading", { name: "Factura creada" });

    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated;
    expect(stale(whole)).toBe(true);
    expect(stale(ungrouped)).toBe(true);
    expect(stale(group)).toBe(false);
  });
});

describe("late responses", () => {
  it("does not touch another identity's cache when the response arrives after a sign-out", async () => {
    let signedIn: "ada" | "bruno" = "ada";
    const response = deferred<Response>();
    const bruno = profileFixture({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Bruno Díaz",
      rut: "111111111",
      memberships: [],
    });
    createTransport(
      () => (signedIn === "ada" ? creator(true) : bruno),
      () => response.promise,
      {
        "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
        "POST /api/v1/auth/login": () => {
          signedIn = "bruno";
          return jsonResponse({ user: {} });
        },
      },
    );
    const { store } = await openForm();
    await fillForm();
    submit();

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "111111111" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "another-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Bruno Díaz/);
    const clientOfBruno = store.getSnapshot().client;

    await act(async () => {
      response.resolve(created({ businessId: "FAC-LATE" }));
    });

    expect(
      screen.queryByRole("heading", { name: "Factura creada" }),
    ).toBeNull();
    expect(store.getSnapshot().client).toBe(clientOfBruno);
    expect(serializeClient(clientOfBruno)).not.toContain("FAC-LATE");
    expect(serializeClient(clientOfBruno)).not.toContain("invoices");
  });
});
