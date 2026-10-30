import { afterEach, describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import { ApiError } from "../../src/http/errors.js";
import type { InvoiceDeleteService } from "../../src/features/invoices/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

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

function harness(overrides: Partial<InvoiceDeleteService> = {}) {
  const service = {
    deleteInvoice: vi.fn<InvoiceDeleteService["deleteInvoice"]>(
      overrides.deleteInvoice ??
        (async () => ({ deleted: true, groupId: null })),
    ),
  };
  const app = createApp({ isReady: async () => true }, fakeAuth(), {
    invoiceDeletion: service,
  });
  const del = (path: string, withSession = true) => {
    const test = request(app).delete(path).set(SAME_ORIGIN);
    return withSession ? test.set("Cookie", COOKIE) : test;
  };
  return { app, service, del };
}

const DELETE_URL = `/api/v1/invoices/${INVOICE_ID}?organizationId=${ORG}`;

function captureInfoLines() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Json);
}

function captureInfoEvents() {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    spy.mock.calls.map(
      ([line]) => (JSON.parse(String(line)) as { event: string }).event,
    );
}

type Json = Record<string, unknown>;

describe("DELETE /api/v1/invoices/{invoiceId} over HTTP", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs invoice.deleted only when the service really deleted", async () => {
    const events = captureInfoEvents();
    const { del } = harness({
      deleteInvoice: async () => ({ deleted: true, groupId: null }),
    });
    await del(DELETE_URL);

    expect(events()).toContain("invoice.deleted");
  });

  it("logs invoice.deleted with the real group of the invoice, not the query's (CR-370)", async () => {
    const lines = captureInfoLines();
    const realGroup = "55555555-5555-4555-8555-555555555555";
    const { del } = harness({
      deleteInvoice: async () => ({ deleted: true, groupId: realGroup }),
    });
    await del(DELETE_URL);

    const deleted = lines().find((line) => line.event === "invoice.deleted");
    expect(deleted).toMatchObject({ groupId: realGroup });
  });

  it("omits groupId from invoice.deleted for an organization invoice (CR-370)", async () => {
    const lines = captureInfoLines();
    const { del } = harness({
      deleteInvoice: async () => ({ deleted: true, groupId: null }),
    });
    await del(DELETE_URL);

    const deleted = lines().find((line) => line.event === "invoice.deleted");
    expect(deleted).toBeDefined();
    expect(deleted).not.toHaveProperty("groupId");
  });

  it("logs no invoice.deleted for an authorized repeat that changed nothing", async () => {
    const events = captureInfoEvents();
    const { del } = harness({
      deleteInvoice: async () => ({ deleted: false, groupId: null }),
    });
    const response = await del(DELETE_URL);

    expect(response.status).toBe(204);
    expect(events()).not.toContain("invoice.deleted");
  });

  it("logs invoice.delete_rejected for a malformed invoice id without echoing it", async () => {
    const lines = captureInfoLines();
    const { del, service } = harness();
    const response = await del(
      `/api/v1/invoices/not-a-uuid-marker?organizationId=${ORG}`,
    );

    expect(response.status).toBe(404);
    expect(service.deleteInvoice).not.toHaveBeenCalled();
    const rejected = lines().find(
      (line) => line.event === "invoice.delete_rejected",
    );
    expect(rejected).toMatchObject({
      feature: "invoices",
      status: 404,
      code: "NOT_FOUND",
      organizationId: ORG,
      actorUserId: "user-1",
    });
    expect(rejected).not.toHaveProperty("invoiceId");
    expect(JSON.stringify(rejected)).not.toContain("not-a-uuid-marker");
  });

  it("answers 401 without a session and never calls the service", async () => {
    const { del, service } = harness();
    const response = await del(DELETE_URL, false);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(service.deleteInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["missing organizationId", `/api/v1/invoices/${INVOICE_ID}`],
    [
      "malformed organizationId",
      `/api/v1/invoices/${INVOICE_ID}?organizationId=nope`,
    ],
    [
      "repeated organizationId",
      `/api/v1/invoices/${INVOICE_ID}?organizationId=${ORG}&organizationId=${ORG}`,
    ],
    ["malformed groupId", `${DELETE_URL}&groupId=nope`],
    ["empty groupId", `${DELETE_URL}&groupId=`],
    ["legacy ownerType", `${DELETE_URL}&ownerType=user`],
    ["legacy ownerId", `${DELETE_URL}&ownerId=user-1`],
    ["list-only filter", `${DELETE_URL}&page=1`],
    ["unknown query key", `${DELETE_URL}&force=true`],
  ])("answers 400 for %s before the service", async (_label, path) => {
    const { del, service } = harness();
    const response = await del(path);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.deleteInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["an encoded slash", "a%2Fb"],
    ["an encoded backslash", "a%5Cb"],
    ["a dot segment", "%2E%2E"],
  ])("rejects an invoiceId with %s as a missing route", async (_label, id) => {
    const { del, service } = harness();
    const response = await del(`/api/v1/invoices/${id}?organizationId=${ORG}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(service.deleteInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["a NUL byte", "%00"],
    ["a NUL byte after a valid uuid", `${INVOICE_ID}%00`],
    ["a non-uuid string", "not-a-uuid"],
    ["a short number", "123"],
  ])(
    "answers the generic 404 for an invoiceId that is %s without calling the service",
    async (_label, id) => {
      const { del, service } = harness();
      const response = await del(
        `/api/v1/invoices/${id}?organizationId=${ORG}`,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: { code: "NOT_FOUND", message: "Not found" },
      });
      expect(service.deleteInvoice).not.toHaveBeenCalled();
    },
  );

  it("passes the session identity, the path id and the organization", async () => {
    const { del, service } = harness();
    const response = await del(DELETE_URL);

    expect(response.status).toBe(204);
    expect(service.deleteInvoice).toHaveBeenCalledTimes(1);
    expect(service.deleteInvoice).toHaveBeenCalledWith("user-1", {
      invoiceId: INVOICE_ID,
      organizationId: ORG,
    });
  });

  it("passes the groupId context when given", async () => {
    const { del, service } = harness();
    const response = await del(`${DELETE_URL}&groupId=${GROUP}`);

    expect(response.status).toBe(204);
    expect(service.deleteInvoice).toHaveBeenCalledWith("user-1", {
      invoiceId: INVOICE_ID,
      organizationId: ORG,
      groupId: GROUP,
    });
  });

  it("answers 204 with an empty body and no content type", async () => {
    const { del } = harness();
    const response = await del(DELETE_URL);

    expect(response.status).toBe(204);
    expect(response.text ?? "").toBe("");
    expect(response.headers["content-type"]).toBeUndefined();
  });

  it.each([
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ] as const)(
    "maps a service %i %s to the error envelope",
    async (status, code) => {
      const { del, service } = harness({
        deleteInvoice: async () => {
          throw new ApiError(status, code, "denied");
        },
      });
      const response = await del(DELETE_URL);

      expect(service.deleteInvoice).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
    },
  );

  it("answers the same 404 body whichever invoice or context was asked", async () => {
    const { del, service } = harness({
      deleteInvoice: async () => {
        throw new ApiError(404, "NOT_FOUND", "Not found");
      },
    });
    const other = "55555555-5555-4555-8555-555555555555";

    const responses = [
      await del(DELETE_URL),
      await del(`/api/v1/invoices/${other}?organizationId=${ORG}`),
      await del(`${DELETE_URL}&groupId=${GROUP}`),
    ];

    expect(service.deleteInvoice).toHaveBeenCalledTimes(3);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[0]?.body);
    }
  });

  it("answers the retryable 503 with Retry-After when conflicts exhaust retries", async () => {
    const { del } = harness({
      deleteInvoice: async () => {
        throw new ApiError(503, "RETRYABLE_CONFLICT", "retry", undefined, {
          "Retry-After": "1",
        });
      },
    });
    const response = await del(DELETE_URL);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
    expect(response.headers["retry-after"]).toBe("1");
  });

  it("answers 401 when the delete service is not wired", async () => {
    const app = createApp({ isReady: async () => true }, fakeAuth());
    const response = await request(app)
      .delete(DELETE_URL)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(401);
  });
});
