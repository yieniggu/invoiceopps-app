import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createInvoiceReadService } from "../../src/features/invoices/services.js";
import { ApiError } from "../../src/http/errors.js";

// CR-328: a read transaction that times out (Prisma P2028) answers the same
// retryable 503 as the writes instead of an unexpected 500.

const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

function serviceFailingWith(code: string) {
  const transaction = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("failure"), { code }));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { service: createInvoiceReadService(prisma), transaction };
}

describe("createInvoiceReadService transaction failures (CR-328)", () => {
  it("maps a list transaction timeout to the retryable 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, transaction } = serviceFailingWith("P2028");

    const outcome = await service
      .listInvoices(
        "user-1",
        { organizationId: ORG, ungrouped: false, page: 1, pageSize: 20 },
        null,
      )
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("maps a detail transaction timeout to the retryable 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = serviceFailingWith("P2028");

    const outcome = await service
      .getInvoice(
        "user-1",
        { invoiceId: INVOICE_ID, organizationId: ORG },
        null,
      )
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
  });

  it("does not hide an unrelated failure", async () => {
    const { service } = serviceFailingWith("P1001");

    const outcome = await service
      .getInvoice(
        "user-1",
        { invoiceId: INVOICE_ID, organizationId: ORG },
        null,
      )
      .catch((error: unknown) => error);

    expect(outcome).not.toBeInstanceOf(ApiError);
  });
});

// CR-009: administrators read every invoice (read-only widening) inside the
// read service only; a token is always evaluated as before.

const GROUP = "22222222-2222-4222-8222-222222222222";
const FLAGS_OFF = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
  deployModels: false,
};

interface World {
  role?: "ADMIN" | "USER" | null;
  flags?: Partial<typeof FLAGS_OFF>;
  platform?: boolean;
  enabled?: boolean;
  mustChangePassword?: boolean;
  orgExists?: boolean;
  groupMember?: boolean;
}

function serviceFor(world: World) {
  const membership =
    world.role == null
      ? null
      : { userId: "u", role: world.role, ...FLAGS_OFF, ...world.flags };
  const invoiceRow = {
    id: INVOICE_ID,
    organizationId: ORG,
    groupId: GROUP,
    businessId: "FAC-1",
    supplierName: "S",
    amountPesos: 1,
    currency: "CLP",
    issuedOn: new Date("2026-01-01T00:00:00.000Z"),
    dueOn: new Date("2026-02-01T00:00:00.000Z"),
    businessStatus: "PENDING",
    processingStatus: "NOT_REQUESTED",
    createdByUserId: "creator",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    group: { name: "G" },
  };
  const findMany = vi.fn().mockResolvedValue([invoiceRow]);
  const client = {
    apiToken: { findFirst: vi.fn().mockResolvedValue({ id: "t" }) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        disabledAt: null,
        mustChangePassword: world.mustChangePassword ?? false,
      }),
    },
    platformAdministrator: {
      findUnique: vi
        .fn()
        .mockResolvedValue(world.platform ? { userId: "user-1" } : null),
    },
    organization: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          world.orgExists === false
            ? null
            : { id: ORG, enabled: world.enabled ?? true },
        ),
    },
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue(membership),
    },
    group: { findFirst: vi.fn().mockResolvedValue({ id: GROUP }) },
    groupMembership: {
      findFirst: vi
        .fn()
        .mockResolvedValue(world.groupMember ? { ...FLAGS_OFF } : null),
    },
    invoice: {
      findMany,
      count: vi.fn().mockResolvedValue(1),
      findFirst: vi.fn().mockResolvedValue(invoiceRow),
    },
  };
  const prisma = {
    $transaction: (work: (tx: unknown) => unknown) => work(client),
  } as unknown as PrismaClient;
  return { service: createInvoiceReadService(prisma), findMany };
}

const TOKEN = {
  id: "t",
  organizationId: ORG,
  groupId: null,
  scopes: ["invoices:read" as const],
};
const LIST = {
  organizationId: ORG,
  ungrouped: false,
  page: 2,
  pageSize: 10,
};
const DETAIL = { invoiceId: INVOICE_ID, organizationId: ORG };

const statusOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 200,
    (error: unknown) => (error as ApiError).status,
  );

describe("createInvoiceReadService administrators (CR-009)", () => {
  it("lets the platform administrator list and read without membership", async () => {
    const { service, findMany } = serviceFor({ platform: true });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      200,
    );
    expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
      200,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG }),
        skip: 10,
        take: 10,
      }),
    );
  });

  it("lets a platform administrator who is also a USER member without flags read as an administrator", async () => {
    const { service } = serviceFor({ role: "USER", platform: true });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      200,
    );
    expect(
      await statusOf(
        service.listInvoices("user-1", { ...LIST, groupId: GROUP }, null),
      ),
    ).toBe(200);
    expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
      200,
    );
  });

  it("answers 404 to the platform administrator for a missing organization", async () => {
    const { service } = serviceFor({ platform: true, orgExists: false });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      404,
    );
    expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
      404,
    );
  });

  it("lets an organization ADMIN without flags or group membership list and read", async () => {
    const { service } = serviceFor({ role: "ADMIN" });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      200,
    );
    expect(
      await statusOf(
        service.listInvoices("user-1", { ...LIST, groupId: GROUP }, null),
      ),
    ).toBe(200);
    expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
      200,
    );
  });

  it("keeps a regular member on 403 without read and 404 outside the group", async () => {
    const { service } = serviceFor({ role: "USER" });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      403,
    );
    expect(
      await statusOf(
        service.listInvoices("user-1", { ...LIST, groupId: GROUP }, null),
      ),
    ).toBe(404);
    expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
      404,
    );
  });

  it("keeps a non-member that is not the platform administrator on 404", async () => {
    const { service } = serviceFor({ role: null });

    expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
      404,
    );
  });

  it.each([
    ["ADMIN", { role: "ADMIN" as const }],
    ["platform administrator", { platform: true }],
  ])(
    "keeps a disabled organization on 403 for the %s",
    async (_label, world) => {
      const { service } = serviceFor({ ...world, enabled: false });

      expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
        403,
      );
      expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
        403,
      );
    },
  );

  it.each([
    ["ADMIN", { role: "ADMIN" as const }],
    ["platform administrator", { platform: true }],
  ])(
    "keeps a pending temporary password on 403 for the %s",
    async (_label, world) => {
      const { service } = serviceFor({ ...world, mustChangePassword: true });

      expect(await statusOf(service.listInvoices("user-1", LIST, null))).toBe(
        403,
      );
      expect(await statusOf(service.getInvoice("user-1", DETAIL, null))).toBe(
        403,
      );
    },
  );

  it("never widens a token: an ADMIN token without flags is evaluated as before", async () => {
    const { service } = serviceFor({ role: "ADMIN" });

    expect(await statusOf(service.listInvoices("user-1", LIST, TOKEN))).toBe(
      403,
    );
    expect(await statusOf(service.getInvoice("user-1", DETAIL, TOKEN))).toBe(
      404,
    );
  });

  it("never widens a token owned by the platform administrator", async () => {
    const { service } = serviceFor({ platform: true });

    expect(await statusOf(service.listInvoices("user-1", LIST, TOKEN))).toBe(
      404,
    );
    expect(await statusOf(service.getInvoice("user-1", DETAIL, TOKEN))).toBe(
      404,
    );
  });
});
