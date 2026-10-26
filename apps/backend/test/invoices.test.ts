import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { AuthError, type AuthService } from "../src/auth.js";
import {
  createInvoiceService as createPrismaInvoiceService,
  toInvoiceDto,
  type InvoiceDto,
  type InvoiceService,
} from "../src/invoices.js";

const context = {
  organizationId: "organization-1",
  ownerType: "user" as const,
  ownerId: "user-1",
};

function createAuth(): AuthService {
  return {
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
        isPlatformAdministrator: false,
        memberships: [],
      };
    },
    async updateProfile() {
      throw new Error("not used");
    },
  };
}

const invoice: InvoiceDto = {
  id: "11111111-1111-4111-8111-111111111111",
  businessId: "FAC-2026-001",
  organizationId: "organization-1",
  groupId: "group-1",
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

function createInvoiceService(): InvoiceService {
  return {
    async listInvoices(userId, receivedContext, query) {
      expect(userId).toBe("user-1");
      expect(receivedContext).toEqual(context);
      expect(query).toEqual({ q: "acme", cursor: undefined, limit: 50 });
      return { invoices: [invoice], nextCursor: null };
    },
    async getInvoice(userId, receivedContext, invoiceId) {
      expect(userId).toBe("user-1");
      expect(receivedContext).toEqual(context);
      expect(invoiceId).toBe(invoice.id);
      return { invoice };
    },
  };
}

describe("APP-06 invoice HTTP contract", () => {
  it("lists and reads invoices in the active authorized context", async () => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });
    const query = new URLSearchParams({ ...context, q: "acme" });

    const list = await request(app)
      .get(`/invoices?${query}`)
      .set("Cookie", "invoiceops_session=valid-session");
    const detail = await request(app)
      .get(`/invoices/${invoice.id}?${query}`)
      .set("Cookie", "invoiceops_session=valid-session");
    expect(list.status).toBe(200);
    expect(list.body.invoices[0]).toMatchObject({ businessId: "FAC-2026-001" });
    expect(detail.status).toBe(200);
    expect(detail.body.invoice).toEqual(invoice);
  });

  it("maps a malformed percent-escaped invoice id to 400 without logging or leaking", async () => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app)
        .get(
          "/invoices/%E0%A4%A?organizationId=organization-1&ownerType=group&ownerId=group-1",
        )
        .set("Cookie", "invoiceops_session=valid-session");
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        status: "error",
        message: "Bad request",
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /URIError|at \w+|stack/,
      );
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
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

  it.each([
    [
      "invalid ownerType",
      { organizationId: "o", ownerType: "team", ownerId: "u" },
    ],
    ["missing ownerId", { organizationId: "o", ownerType: "user" }],
    ["missing organizationId", { ownerType: "user", ownerId: "u" }],
  ])("returns 400 for %s on GET /invoices", async (_label, params) => {
    const app = createApp({ isReady: async () => true }, createAuth(), {
      invoices: createInvoiceService(),
    });
    const response = await request(app)
      .get(`/invoices?${new URLSearchParams(params)}`)
      .set("Cookie", "invoiceops_session=valid-session");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      status: "error",
      message: "Invalid resource context",
    });
  });
});

describe("invoice read model (P0)", () => {
  const row = {
    id: invoice.id,
    businessId: invoice.businessId,
    organizationId: invoice.organizationId,
    groupId: invoice.groupId,
    supplierName: invoice.supplierName,
    amountPesos: 12500,
    currency: "CLP" as const,
    issuedOn: new Date("2026-10-25T00:00:00.000Z"),
    dueOn: new Date("2026-11-25T00:00:00.000Z"),
    businessStatus: "PENDING" as const,
    processingStatus: "NOT_REQUESTED" as const,
    createdByUserId: "user-1",
    createdAt: new Date("2026-10-25T12:00:00.000Z"),
    deletedAt: null,
    deletedByUserId: null,
    internal: "must-not-leak",
  };

  it("maps explicitly without leaking internal columns or shifting dates", () => {
    const originalTimezone = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      expect(toInvoiceDto(row)).toEqual(invoice);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
    expect(Object.keys(toInvoiceDto(row)).sort()).toEqual([
      "amountPesos",
      "businessId",
      "businessStatus",
      "createdAt",
      "createdByUserId",
      "currency",
      "dueOn",
      "groupId",
      "id",
      "issuedOn",
      "organizationId",
      "processingStatus",
      "supplierName",
    ]);
  });

  function fakePrisma() {
    const findMany = vi.fn(async () => [row]);
    const findFirst = vi.fn(async () => row);
    const prisma = {
      organizationMembership: {
        findUnique: vi.fn(async () => ({ userId: "user-1" })),
      },
      groupMembership: { findFirst: vi.fn(async () => ({ userId: "user-1" })) },
      invoice: { findMany, findFirst },
    };
    return { prisma, findMany, findFirst };
  }

  it("filters group lists by group and organization excluding deleted rows", async () => {
    const { prisma, findMany } = fakePrisma();
    const service = createPrismaInvoiceService(prisma as never);
    const result = await service.listInvoices(
      "user-1",
      {
        organizationId: "organization-1",
        ownerType: "group",
        ownerId: "group-1",
      },
      { q: "", limit: 10 },
    );
    expect(result.invoices).toEqual([invoice]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              organizationId: "organization-1",
              groupId: "group-1",
              deletedAt: null,
            },
          ],
        },
      }),
    );
  });

  it("has no personal invoices: user lists are empty and details are 404", async () => {
    const { prisma, findMany, findFirst } = fakePrisma();
    const service = createPrismaInvoiceService(prisma as never);
    const userContext = {
      organizationId: "organization-1",
      ownerType: "user" as const,
      ownerId: "user-1",
    };
    await expect(
      service.listInvoices("user-1", userContext, { q: "", limit: 10 }),
    ).resolves.toEqual({ invoices: [], nextCursor: null });
    await expect(
      service.getInvoice("user-1", userContext, invoice.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(findMany).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing or deleted group invoice", async () => {
    const { prisma, findFirst } = fakePrisma();
    findFirst.mockResolvedValueOnce(null as never);
    const service = createPrismaInvoiceService(prisma as never);
    await expect(
      service.getInvoice(
        "user-1",
        {
          organizationId: "organization-1",
          ownerType: "group",
          ownerId: "group-1",
        },
        invoice.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: invoice.id,
        organizationId: "organization-1",
        groupId: "group-1",
        deletedAt: null,
      },
    });
  });
});
