import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IdempotencyKeySchema,
  InvoiceCreateRequestSchema,
  InvoiceSchema,
} from "../../src/features/invoices/schemas.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  createInvoiceCreateService,
  replayedInvoice,
} from "../../src/features/invoices/services.js";
import { ApiError } from "../../src/http/errors.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";

const VALID = {
  organizationId: ORGANIZATION_ID,
  groupId: GROUP_ID,
  businessId: "FAC-2026-001",
  supplierName: "Proveedor local",
  amountPesos: 12500,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  businessStatus: "PENDING",
};

function parse(body: unknown) {
  return InvoiceCreateRequestSchema.safeParse(body);
}

function withoutGroup(): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy.groupId;
  return copy;
}

describe("InvoiceCreateRequestSchema scope (AC-09)", () => {
  it("accepts a group-scoped invoice", () => {
    const result = parse(VALID);
    expect(result.success).toBe(true);
    expect(result.data?.groupId).toBe(GROUP_ID);
  });

  it("normalizes an omitted groupId to the organization scope (null)", () => {
    const result = parse(withoutGroup());
    expect(result.success).toBe(true);
    expect(result.data?.groupId).toBeNull();
  });

  it("accepts an explicit null groupId as the organization scope", () => {
    const result = parse({ ...VALID, groupId: null });
    expect(result.success).toBe(true);
    expect(result.data?.groupId).toBeNull();
  });

  it.each(["", "not-a-uuid", 42])("rejects groupId %j", (groupId) => {
    expect(parse({ ...VALID, groupId }).success).toBe(false);
  });
});

describe("InvoiceCreateRequestSchema validation (AC-04)", () => {
  it.each([1, 2_147_483_647])("accepts amountPesos %d", (amountPesos) => {
    expect(parse({ ...VALID, amountPesos }).success).toBe(true);
  });

  it.each([
    0,
    -1,
    2_147_483_648,
    12.5,
    "12500",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects amountPesos %j", (amountPesos) => {
    expect(parse({ ...VALID, amountPesos }).success).toBe(false);
  });

  it("accepts a leap day and an equal due date", () => {
    expect(
      parse({ ...VALID, issuedOn: "2028-02-29", dueOn: "2028-02-29" }).success,
    ).toBe(true);
  });

  it.each(["2026-02-29", "2026-13-01", "2026-10-32", "25-10-2026", ""])(
    "rejects impossible issuedOn %j",
    (issuedOn) => {
      expect(parse({ ...VALID, issuedOn }).success).toBe(false);
    },
  );

  it("rejects a due date before the issue date", () => {
    expect(
      parse({ ...VALID, issuedOn: "2026-10-25", dueOn: "2026-10-24" }).success,
    ).toBe(false);
  });

  it("rejects currencies other than CLP", () => {
    expect(parse({ ...VALID, currency: "USD" }).success).toBe(false);
  });

  it.each(["businessId", "supplierName"] as const)(
    "rejects a blank %s and trims surrounding whitespace",
    (field) => {
      expect(parse({ ...VALID, [field]: "   " }).success).toBe(false);
      expect(parse({ ...VALID, [field]: "  X  " }).data?.[field]).toBe("X");
    },
  );

  it("bounds businessId to 80 and supplierName to 200 characters", () => {
    expect(parse({ ...VALID, businessId: "B".repeat(80) }).success).toBe(true);
    expect(parse({ ...VALID, businessId: "B".repeat(81) }).success).toBe(false);
    expect(parse({ ...VALID, supplierName: "S".repeat(200) }).success).toBe(
      true,
    );
    expect(parse({ ...VALID, supplierName: "S".repeat(201) }).success).toBe(
      false,
    );
  });

  it.each([
    "id",
    "createdByUserId",
    "createdAt",
    "processingStatus",
    "scopeKey",
    "deletedAt",
    "unexpected",
  ])("rejects the server-only or unknown field %s", (field) => {
    expect(parse({ ...VALID, [field]: "x" }).success).toBe(false);
  });

  it("requires businessStatus from the closed set", () => {
    expect(parse({ ...VALID, businessStatus: "DRAFT" }).success).toBe(false);
    expect(parse(withoutField("businessStatus")).success).toBe(false);
  });
});

function withoutField(field: keyof typeof VALID): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy[field];
  return copy;
}

describe("IdempotencyKeySchema (AC-06)", () => {
  it.each(["a".repeat(16), "A".repeat(128), "abc_DEF-123_xyz-9"])(
    "accepts %j",
    (key) => {
      expect(IdempotencyKeySchema.safeParse(key).success).toBe(true);
    },
  );

  it.each([
    undefined,
    "",
    "a".repeat(15),
    "a".repeat(129),
    "with space 123456",
    "dots.are.not.allowed",
    "ñandú-1234567890123",
    ["a".repeat(16)],
  ])("rejects %j", (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe("InvoiceSchema response DTO (AC-01)", () => {
  it("allows an organization-scoped invoice with a null groupId", () => {
    const result = InvoiceSchema.safeParse({
      ...VALID,
      groupId: null,
      id: "33333333-3333-4333-8333-333333333333",
      processingStatus: "NOT_REQUESTED",
      createdByUserId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-10-25T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("replayedInvoice (CR-322)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SNAPSHOT = {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ORGANIZATION_ID,
    groupId: GROUP_ID,
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
  };

  it("returns a snapshot that satisfies the Invoice contract", () => {
    expect(replayedInvoice(SNAPSHOT)).toEqual(SNAPSHOT);
  });

  it("answers a controlled 500 and logs no payload for a corrupt snapshot", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const corrupt = { ...SNAPSHOT, amountPesos: "12500" };

    let thrown: unknown;
    try {
      replayedInvoice(corrupt);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "invoice.replay_snapshot_invalid",
    });
    expect(line).not.toContain("FAC-2026-001");
    expect(line).not.toContain("Proveedor local");
  });
});

describe("createInvoice unique-violation retries (CR-326)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a retryable 503 and logs the give-up after three unique violations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi.fn(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const service = createInvoiceCreateService({
      $transaction: transaction,
    } as unknown as PrismaClient);

    const outcome = service.createInvoice(
      "44444444-4444-4444-8444-444444444444",
      InvoiceCreateRequestSchema.parse(VALID),
      "a".repeat(16),
    );

    await expect(outcome).rejects.toMatchObject({
      status: 503,
      code: "RETRYABLE_CONFLICT",
    });
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      event: "transaction.conflict",
      operation: "invoice_create",
      outcome: "gave_up",
    });
  });
});
