import { afterEach, describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import { ApiError } from "../../src/http/errors.js";
import type { InvoiceCreateService } from "../../src/features/invoices/services.js";
import type { Invoice } from "../../src/features/invoices/types.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const KEY = "idempotency-key-0001";

const BODY = {
  organizationId: ORG,
  groupId: GROUP,
  businessId: "FAC-2026-001",
  supplierName: "Proveedor local",
  amountPesos: 12500,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  businessStatus: "PENDING",
};

const INVOICE: Invoice = {
  id: "33333333-3333-4333-8333-333333333333",
  organizationId: ORG,
  groupId: GROUP,
  businessId: "FAC-2026-001",
  supplierName: "Proveedor local",
  amountPesos: 12500,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  businessStatus: "PENDING",
  processingStatus: "NOT_REQUESTED",
  createdByUserId: "user-1",
  createdAt: "2026-10-25T12:00:00.000Z",
};

const profile = {
  id: "user-1",
  name: "Ada",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: false,
  memberships: [],
};

function fakeAuth(mustChangePassword = false): AuthService {
  return {
    async login() {
      return {
        sessionToken: "opaque-session-token",
        user: { id: "user-1", name: "Ada", rut: "123456785" },
      };
    },
    async logout() {},
    async getProfile() {
      return { ...profile, mustChangePassword };
    },
    async updateProfile() {
      return profile;
    },
    async changePassword() {
      return { sessionToken: "rotated-session-token" };
    },
  };
}

function harness(
  createInvoice: InvoiceCreateService["createInvoice"] = async () => ({
    invoice: INVOICE,
    replayed: false,
  }),
  auth: AuthService = fakeAuth(),
) {
  const service = { createInvoice: vi.fn(createInvoice) };
  const app = createApp({ isReady: async () => true }, auth, {
    invoiceCreation: service as InvoiceCreateService,
  });
  // A null key omits the header.
  const post = (body: unknown = BODY, key: string | null = KEY) => {
    let test = request(app)
      .post("/api/v1/invoices")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    if (key !== null) test = test.set("Idempotency-Key", key);
    return test.send(body as object);
  };
  return { app, service, post };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLogs() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
}

describe("POST /api/v1/invoices structured logs (CR-324)", () => {
  const FORBIDDEN = [
    "FAC-2026-001",
    "Proveedor local",
    "12500",
    KEY,
    "businessId",
    "supplierName",
    "amountPesos",
  ];

  it.each([
    ["invoice.created", false],
    ["invoice.replayed", true],
  ])("emits %s with opaque ids only", async (event, replayed) => {
    const logs = captureLogs();
    const { post } = harness(async () => ({ invoice: INVOICE, replayed }));
    await post();

    const entry = logs().find((line) => line.event === event);
    expect(entry).toMatchObject({
      level: "info",
      organizationId: ORG,
      groupId: GROUP,
      invoiceId: INVOICE.id,
    });
    const serialized = JSON.stringify(entry);
    for (const value of FORBIDDEN) expect(serialized).not.toContain(value);
  });

  it("logs a rejected create with its code and nothing else sensitive", async () => {
    const logs = captureLogs();
    const { post } = harness(async () => {
      throw new ApiError(409, "BUSINESS_ID_CONFLICT", "conflict");
    });
    const response = await post();

    expect(response.status).toBe(409);
    const entries = logs().filter(
      (line) => line.event === "invoice.create_rejected",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ code: "BUSINESS_ID_CONFLICT" });
    const serialized = JSON.stringify(entries[0]);
    for (const value of FORBIDDEN) expect(serialized).not.toContain(value);
  });
});

describe("POST /api/v1/invoices over HTTP", () => {
  it("answers 401 without a session and never calls the service (AC-03)", async () => {
    const { app, service } = harness();
    const response = await request(app)
      .post("/api/v1/invoices")
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", KEY)
      .send(BODY);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(service.createInvoice).not.toHaveBeenCalled();
  });

  it("rejects a Bearer credential and never calls the service", async () => {
    const { app, service } = harness();
    const response = await request(app)
      .post("/api/v1/invoices")
      .set(SAME_ORIGIN)
      .set("Authorization", "Bearer some-token")
      .set("Idempotency-Key", KEY)
      .send(BODY);

    expect(response.status).toBe(401);
    expect(service.createInvoice).not.toHaveBeenCalled();
  });

  it("blocks the route while a temporary password is pending", async () => {
    const { post, service } = harness(undefined, fakeAuth(true));
    const response = await post();

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    expect(service.createInvoice).not.toHaveBeenCalled();
  });

  it("keeps the Origin check on the cookie write", async () => {
    const { app, service } = harness();
    const response = await request(app)
      .post("/api/v1/invoices")
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", COOKIE)
      .set("Idempotency-Key", KEY)
      .send(BODY);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(service.createInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["too short", "a".repeat(15)],
    ["too long", "a".repeat(129)],
    ["with a space", "invalid key with spaces"],
    ["with a dot", "dots.are.not.allowed.1"],
  ])(
    "answers 400 for a %s Idempotency-Key before the service (AC-06)",
    async (_label, key) => {
      const { post, service } = harness();
      const response = await post(BODY, key);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(response.body.error.fields)).toEqual([
        "Idempotency-Key",
      ]);
      expect(service.createInvoice).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["zero amount", { ...BODY, amountPesos: 0 }],
    ["fractional amount", { ...BODY, amountPesos: 12.5 }],
    ["foreign currency", { ...BODY, currency: "USD" }],
    ["impossible date", { ...BODY, issuedOn: "2026-02-30" }],
    ["due before issue", { ...BODY, dueOn: "2026-10-24" }],
    ["server-only field", { ...BODY, createdByUserId: "someone" }],
    ["unknown field", { ...BODY, extra: true }],
    ["blank businessId", { ...BODY, businessId: "  " }],
    ["malformed organizationId", { ...BODY, organizationId: "nope" }],
  ])(
    "answers 400 for an invalid body (%s) before the service (AC-04)",
    async (_label, body) => {
      const { post, service } = harness();
      const response = await post(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(service.createInvoice).not.toHaveBeenCalled();
    },
  );

  it("creates with the session identity, the normalized body and a contextual Location (AC-01)", async () => {
    const { post, service } = harness();
    const response = await post();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ invoice: INVOICE });
    expect(response.headers.location).toBe(
      `/api/v1/invoices/${INVOICE.id}?organizationId=${ORG}&groupId=${GROUP}`,
    );
    expect(response.headers["idempotency-replayed"]).toBeUndefined();
    expect(service.createInvoice).toHaveBeenCalledWith("user-1", BODY, KEY);
  });

  it("omits groupId from the Location of an organization-scoped invoice and passes null (AC-01)", async () => {
    const orgInvoice = { ...INVOICE, groupId: null };
    const { post, service } = harness(async () => ({
      invoice: orgInvoice,
      replayed: false,
    }));
    const withoutGroup: Record<string, unknown> = { ...BODY };
    delete withoutGroup.groupId;
    const response = await post(withoutGroup);

    expect(response.status).toBe(201);
    expect(response.body.invoice.groupId).toBeNull();
    expect(response.headers.location).toBe(
      `/api/v1/invoices/${INVOICE.id}?organizationId=${ORG}`,
    );
    expect(service.createInvoice).toHaveBeenCalledWith(
      "user-1",
      { ...BODY, groupId: null },
      KEY,
    );
  });

  it("marks a replay with Idempotency-Replayed and the same 201 (AC-07)", async () => {
    const { post } = harness(async () => ({
      invoice: INVOICE,
      replayed: true,
    }));
    const response = await post();

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ invoice: INVOICE });
    expect(response.headers["idempotency-replayed"]).toBe("true");
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "IDEMPOTENCY_CONFLICT"],
    [409, "BUSINESS_ID_CONFLICT"],
    [410, "INVOICE_DELETED"],
  ] as const)(
    "maps a service %i %s to the error envelope",
    async (status, code) => {
      const { post } = harness(async () => {
        throw new ApiError(status, code, "denied");
      });
      const response = await post();

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );

  it("answers the retryable 503 with Retry-After when conflicts exhaust retries", async () => {
    const { post } = harness(async () => {
      throw new ApiError(503, "RETRYABLE_CONFLICT", "retry", undefined, {
        "Retry-After": "1",
      });
    });
    const response = await post();

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
  });

  it("does not call external services while creating (AC-14)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { post } = harness();
      expect((await post()).status).toBe(201);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("POST /api/v1/invoices OpenAPI statuses (AC-15)", () => {
  it.each([201, 400, 401, 403, 404, 409, 410, 503])(
    "documents %i",
    async (status) => {
      const { app } = harness();
      const document = (await request(app).get("/openapi.json")).body;
      const operation = document.paths["/api/v1/invoices"].post;

      expect(Object.keys(operation.responses)).toContain(String(status));
    },
  );
});
