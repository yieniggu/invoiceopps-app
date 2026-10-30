import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import { ApiError } from "../../src/http/errors.js";
import type { InvoiceReadService } from "../../src/features/invoices/services.js";
import type { InvoiceView } from "../../src/features/invoices/types.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

const INVOICE: InvoiceView = {
  id: INVOICE_ID,
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
  createdByUserId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-10-25T12:00:00.000Z",
  groupName: "Finanzas",
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

function fakeAuth(): AuthService {
  return {
    async login() {
      return {
        sessionToken: "opaque-session-token",
        user: { id: "user-1", name: "Ada", rut: "123456785" },
      };
    },
    async logout() {},
    async getProfile() {
      return profile;
    },
    async updateProfile() {
      return profile;
    },
    async changePassword() {
      return { sessionToken: "rotated-session-token" };
    },
  };
}

function harness(overrides: Partial<InvoiceReadService> = {}) {
  const service = {
    listInvoices: vi.fn<InvoiceReadService["listInvoices"]>(
      overrides.listInvoices ??
        (async (_userId, query) => ({
          items: [INVOICE],
          page: query.page,
          pageSize: query.pageSize,
          total: 1,
        })),
    ),
    getInvoice: vi.fn<InvoiceReadService["getInvoice"]>(
      overrides.getInvoice ?? (async () => ({ invoice: INVOICE })),
    ),
  };
  const app = createApp({ isReady: async () => true }, fakeAuth(), {
    invoiceReads: service,
  });
  const get = (path: string, withSession = true) => {
    const test = request(app).get(path).set(SAME_ORIGIN);
    return withSession ? test.set("Cookie", COOKIE) : test;
  };
  return { app, service, get };
}

const LIST = `/api/v1/invoices?organizationId=${ORG}`;
const DETAIL = `/api/v1/invoices/${INVOICE_ID}?organizationId=${ORG}`;

describe("GET /api/v1/invoices over HTTP", () => {
  it("answers 401 without a session and never calls the service", async () => {
    const { get, service } = harness();
    const response = await get(LIST, false);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(service.listInvoices).not.toHaveBeenCalled();
  });

  it.each([
    ["missing organizationId", "/api/v1/invoices"],
    ["malformed organizationId", "/api/v1/invoices?organizationId=nope"],
    ["malformed groupId", `${LIST}&groupId=nope`],
    ["groupId with ungrouped=true", `${LIST}&groupId=${GROUP}&ungrouped=true`],
    ["non-boolean ungrouped", `${LIST}&ungrouped=yes`],
    ["unknown businessStatus", `${LIST}&businessStatus=DRAFT`],
    ["processingStatus filter", `${LIST}&processingStatus=NOT_REQUESTED`],
    ["inverted dates", `${LIST}&issuedFrom=2026-02-01&issuedTo=2026-01-01`],
    ["impossible date", `${LIST}&issuedFrom=2026-02-30`],
    ["overlong q", `${LIST}&q=${"a".repeat(121)}`],
    ["q with a NUL byte", `${LIST}&q=ab%00cd`],
    ["repeated q", `${LIST}&q=a&q=b`],
    ["repeated organizationId", `${LIST}&organizationId=${ORG}`],
    ["different repeated organizationId", `${LIST}&organizationId=other`],
    ["pageSize 0", `${LIST}&pageSize=0`],
    ["pageSize 101", `${LIST}&pageSize=101`],
    ["pageSize abc", `${LIST}&pageSize=abc`],
    ["page 0", `${LIST}&page=0`],
    ["page 10001", `${LIST}&page=10001`],
    ["legacy ownerType", `${LIST}&ownerType=user`],
    ["legacy ownerId", `${LIST}&ownerId=user-1`],
    ["legacy cursor", `${LIST}&cursor=abc`],
    ["legacy limit", `${LIST}&limit=10`],
  ])("answers 400 for %s before the service", async (_label, path) => {
    const { get, service } = harness();
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.listInvoices).not.toHaveBeenCalled();
  });

  it("passes the session identity and the parsed query with defaults applied", async () => {
    const { get, service } = harness();
    const response = await get(LIST);

    expect(response.status).toBe(200);
    expect(service.listInvoices).toHaveBeenCalledTimes(1);
    expect(service.listInvoices).toHaveBeenCalledWith("user-1", {
      organizationId: ORG,
      ungrouped: false,
      page: 1,
      pageSize: 20,
    });
  });

  it("passes every filter parsed and trimmed", async () => {
    const { get, service } = harness();
    const response = await get(
      `${LIST}&groupId=${GROUP}&businessStatus=APPROVED&issuedFrom=2026-01-01` +
        `&issuedTo=2026-12-31&q=%20acme%20&page=2&pageSize=5`,
    );

    expect(response.status).toBe(200);
    expect(service.listInvoices).toHaveBeenCalledWith("user-1", {
      organizationId: ORG,
      groupId: GROUP,
      ungrouped: false,
      businessStatus: "APPROVED",
      issuedFrom: "2026-01-01",
      issuedTo: "2026-12-31",
      q: "acme",
      page: 2,
      pageSize: 5,
    });
  });

  it("passes ungrouped=true as a boolean", async () => {
    const { get, service } = harness();
    const response = await get(`${LIST}&ungrouped=true`);

    expect(response.status).toBe(200);
    expect(service.listInvoices).toHaveBeenCalledWith("user-1", {
      organizationId: ORG,
      ungrouped: true,
      page: 1,
      pageSize: 20,
    });
  });

  it("answers 200 with the { items, page, pageSize, total } envelope", async () => {
    const { get } = harness(undefined);
    const response = await get(`${LIST}&page=2&pageSize=5`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [INVOICE],
      page: 2,
      pageSize: 5,
      total: 1,
    });
  });

  it("serializes an organization-scoped invoice with a null groupId", async () => {
    const orgInvoice = { ...INVOICE, groupId: null, groupName: null };
    const { get } = harness({
      listInvoices: async () => ({
        items: [orgInvoice],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    });
    const response = await get(LIST);

    expect(response.status).toBe(200);
    expect(response.body.items[0].groupId).toBeNull();
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const)(
    "maps a service %i %s to the error envelope",
    async (status, code) => {
      const { get } = harness({
        listInvoices: async () => {
          throw new ApiError(status, code, "denied");
        },
      });
      const response = await get(LIST);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );
});

describe("GET /api/v1/invoices/{invoiceId} over HTTP", () => {
  it("answers 401 without a session and never calls the service", async () => {
    const { get, service } = harness();
    const response = await get(DETAIL, false);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(service.getInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["missing organizationId", `/api/v1/invoices/${INVOICE_ID}`],
    [
      "malformed organizationId",
      `/api/v1/invoices/${INVOICE_ID}?organizationId=nope`,
    ],
    ["malformed groupId", `${DETAIL}&groupId=nope`],
    ["legacy ownerType", `${DETAIL}&ownerType=user`],
    ["legacy ownerId", `${DETAIL}&ownerId=user-1`],
    ["list-only filter", `${DETAIL}&page=1`],
  ])("answers 400 for %s before the service", async (_label, path) => {
    const { get, service } = harness();
    const response = await get(path);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.getInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["an encoded slash", "a%2Fb"],
    ["an encoded backslash", "a%5Cb"],
    ["a dot segment", "%2E%2E"],
  ])("rejects an invoiceId with %s as a missing route", async (_label, id) => {
    const { get, service } = harness();
    const response = await get(`/api/v1/invoices/${id}?organizationId=${ORG}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(service.getInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["a NUL byte", "%00"],
    ["a NUL byte after a valid uuid", `${INVOICE_ID}%00`],
    ["a non-uuid string", "not-a-uuid"],
    ["a short number", "123"],
  ])(
    "answers the generic 404 for an invoiceId that is %s without calling the service",
    async (_label, id) => {
      const { get, service } = harness();
      const response = await get(
        `/api/v1/invoices/${id}?organizationId=${ORG}`,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
      expect(service.getInvoice).not.toHaveBeenCalled();
    },
  );

  it("passes the session identity, the path id and the organization", async () => {
    const { get, service } = harness();
    const response = await get(DETAIL);

    expect(response.status).toBe(200);
    expect(service.getInvoice).toHaveBeenCalledWith("user-1", {
      invoiceId: INVOICE_ID,
      organizationId: ORG,
    });
  });

  it("passes the groupId context when given", async () => {
    const { get, service } = harness();
    const response = await get(`${DETAIL}&groupId=${GROUP}`);

    expect(response.status).toBe(200);
    expect(service.getInvoice).toHaveBeenCalledWith("user-1", {
      invoiceId: INVOICE_ID,
      organizationId: ORG,
      groupId: GROUP,
    });
  });

  it("answers 200 with the { invoice } envelope", async () => {
    const { get } = harness();
    const response = await get(DETAIL);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ invoice: INVOICE });
  });

  it("serializes an organization-scoped invoice with a null groupId", async () => {
    const { get } = harness({
      getInvoice: async () => ({
        invoice: { ...INVOICE, groupId: null, groupName: null },
      }),
    });
    const response = await get(DETAIL);

    expect(response.status).toBe(200);
    expect(response.body.invoice.groupId).toBeNull();
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const)(
    "maps a service %i %s to the error envelope",
    async (status, code) => {
      const { get } = harness({
        getInvoice: async () => {
          throw new ApiError(status, code, "denied");
        },
      });
      const response = await get(DETAIL);

      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );

  it("answers the same 404 body whichever invoice or context was asked", async () => {
    const { get } = harness({
      getInvoice: async () => {
        throw new ApiError(404, "NOT_FOUND", "Not found");
      },
    });
    const other = "55555555-5555-4555-8555-555555555555";

    const responses = [
      await get(DETAIL),
      await get(`/api/v1/invoices/${other}?organizationId=${ORG}`),
      await get(`${DETAIL}&groupId=${GROUP}`),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[0]?.body);
    }
  });
});
