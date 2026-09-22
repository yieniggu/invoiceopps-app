import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthError, type AuthService } from "../src/auth.js";
import type { InvoiceService } from "../src/invoices.js";

const context = {
  organizationId: "organization-1",
  ownerType: "user" as const,
  ownerId: "user-1",
};

function createAuth(): AuthService {
  return {
    async signUp() {
      throw new Error("not used");
    },
    async login() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async getProfile(token) {
      if (token !== "valid-session") {
        throw new AuthError(401, "Unauthorized");
      }

      return {
        id: "user-1",
        name: "Ada Lovelace",
        rut: "123456785",
        email: null,
        username: null,
        memberships: [],
      };
    },
    async updateProfile() {
      throw new Error("not used");
    },
  };
}

function createInvoiceService(): InvoiceService {
  return {
    async listInvoices(userId, receivedContext, query) {
      expect(userId).toBe("user-1");
      expect(receivedContext).toEqual(context);
      expect(query).toEqual({ q: "acme", cursor: undefined, limit: 50 });
      return {
        invoices: [
          {
            invoiceId: "INV-001",
            vendorName: "Acme Ltd.",
            invoiceAmountCents: 500_000,
            hasPurchaseOrder: true,
            threeWayMatch: true,
            status: "PENDING",
          },
        ],
        nextCursor: null,
      };
    },
    async getInvoice(userId, receivedContext, invoiceId) {
      expect(userId).toBe("user-1");
      expect(receivedContext).toEqual(context);
      expect(invoiceId).toBe("INV-001");
      return {
        invoice: {
          invoiceId,
          vendorName: "Acme Ltd.",
          invoiceAmountCents: 500_000,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          status: "PENDING",
          riskContext: {
            vendorTenureDays: 365,
            previousIncidents12m: 0,
            bankAccountRecentlyChanged: false,
            amountVsVendorMedian: 1,
            countryRisk: "medium",
          },
          createdAt: "2026-09-21T00:00:00.000Z",
          updatedAt: "2026-09-21T00:00:00.000Z",
        },
        auditEvents: [],
      };
    },
    async decideInvoice(user, receivedContext, invoiceId, decision) {
      expect(user).toMatchObject({
        id: "user-1",
        name: "Ada Lovelace",
        rut: "123456785",
      });
      expect(receivedContext).toEqual(context);
      expect(invoiceId).toBe("INV-001");
      expect(decision).toBe("AUTO_PROCESS");
      return {
        invoice: {
          invoiceId,
          status: "AUTO_PROCESSED",
          updatedAt: "2026-09-21T00:01:00.000Z",
        },
        auditEvent: {
          decision,
          ruleVersion: "invoice-rules-v1",
          actor: { name: "Ada Lovelace", rut: "123456785" },
          correlationId: "correlation-1",
          createdAt: "2026-09-21T00:01:00.000Z",
        },
      };
    },
  };
}

describe("APP-06 invoice HTTP contract", () => {
  it("lists, reads, and decides invoices in the active authorized context", async () => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });
    const query = new URLSearchParams({ ...context, q: "acme" });

    const list = await request(app)
      .get(`/invoices?${query}`)
      .set("Cookie", "invoiceops_session=valid-session");
    const detail = await request(app)
      .get(`/invoices/INV-001?${query}`)
      .set("Cookie", "invoiceops_session=valid-session");
    const decision = await request(app)
      .post(`/invoices/INV-001/decision?${query}`)
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ decision: "AUTO_PROCESS" });

    expect(list.status).toBe(200);
    expect(list.body.invoices[0]).toMatchObject({ invoiceId: "INV-001" });
    expect(detail.status).toBe(200);
    expect(detail.body.invoice.riskContext.countryRisk).toBe("medium");
    expect(decision.status).toBe(200);
    expect(decision.body.auditEvent).toMatchObject({
      ruleVersion: "invoice-rules-v1",
      actor: { name: "Ada Lovelace", rut: "123456785" },
    });
  });

  it("rejects malformed invoice inputs and unauthenticated access", async () => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });

    const invalid = await request(app).get("/invoices?limit=101");
    const unauthenticated = await request(app)
      .get(`/invoices?${new URLSearchParams(context)}`)
      .set("Cookie", "invoiceops_session=invalid-session");

    expect(invalid.status).toBe(400);
    expect(unauthenticated.status).toBe(401);
  });

  it("rejects a cookie-authenticated decision without a same-origin Origin header", async () => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });
    const decision = await request(app)
      .post(`/invoices/INV-001/decision?${new URLSearchParams(context)}`)
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ decision: "AUTO_PROCESS" });

    expect(decision.status).toBe(403);
    expect(decision.body).toEqual({ status: "error", message: "Forbidden" });
  });
});
