import { describe, expect, it } from "vitest";

import {
  InvoiceTargetQuerySchema,
  InvoiceListQuerySchema,
  InvoicePageSchema,
  InvoiceSchema,
  InvoiceViewSchema,
} from "../../src/features/invoices/schemas.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";

const INVOICE = {
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
  createdByUserId: "44444444-4444-4444-8444-444444444444",
  createdAt: "2026-10-25T12:00:00.000Z",
  groupName: "Finanzas",
};

function list(query: unknown) {
  return InvoiceListQuerySchema.safeParse(query);
}

function detail(query: unknown) {
  return InvoiceTargetQuerySchema.safeParse(query);
}

describe("InvoiceListQuerySchema defaults (AC-01, AC-03)", () => {
  it("requires only organizationId and applies the pagination and scope defaults", () => {
    const result = list({ organizationId: ORG });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      organizationId: ORG,
      ungrouped: false,
      page: 1,
      pageSize: 20,
    });
  });

  it("requires organizationId", () => {
    expect(list({}).success).toBe(false);
  });

  it.each(["", "nope", "1234"])("rejects organizationId %j", (value) => {
    expect(list({ organizationId: value }).success).toBe(false);
  });

  it("accepts every filter together and coerces the query strings", () => {
    const result = list({
      organizationId: ORG,
      groupId: GROUP,
      businessStatus: "APPROVED",
      issuedFrom: "2026-01-01",
      issuedTo: "2026-12-31",
      q: "  acme  ",
      page: "3",
      pageSize: "50",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      organizationId: ORG,
      groupId: GROUP,
      ungrouped: false,
      businessStatus: "APPROVED",
      issuedFrom: "2026-01-01",
      issuedTo: "2026-12-31",
      q: "acme",
      page: 3,
      pageSize: 50,
    });
  });
});

describe("InvoiceListQuerySchema ungrouped (AC-03)", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("turns the query string %j into the boolean %s", (raw, expected) => {
    const result = list({ organizationId: ORG, ungrouped: raw });

    expect(result.success).toBe(true);
    expect(result.data?.ungrouped).toBe(expected);
  });

  it.each(["yes", "1", "0", "TRUE", ""])("rejects ungrouped %j", (raw) => {
    expect(list({ organizationId: ORG, ungrouped: raw }).success).toBe(false);
  });

  it("rejects groupId together with ungrouped=true", () => {
    expect(
      list({ organizationId: ORG, groupId: GROUP, ungrouped: "true" }).success,
    ).toBe(false);
  });

  it("accepts groupId together with ungrouped=false", () => {
    const result = list({
      organizationId: ORG,
      groupId: GROUP,
      ungrouped: "false",
    });

    expect(result.success).toBe(true);
    expect(result.data?.groupId).toBe(GROUP);
  });

  it("rejects a malformed groupId", () => {
    expect(list({ organizationId: ORG, groupId: "nope" }).success).toBe(false);
  });
});

describe("InvoiceListQuerySchema filters (AC-04)", () => {
  it.each(["PENDING", "APPROVED", "REJECTED", "CANCELLED"])(
    "accepts businessStatus %s",
    (businessStatus) => {
      expect(list({ organizationId: ORG, businessStatus }).success).toBe(true);
    },
  );

  it.each(["pending", "DRAFT", "NOT_REQUESTED", ""])(
    "rejects businessStatus %j",
    (businessStatus) => {
      expect(list({ organizationId: ORG, businessStatus }).success).toBe(false);
    },
  );

  it("rejects an inverted issued range", () => {
    expect(
      list({
        organizationId: ORG,
        issuedFrom: "2026-02-01",
        issuedTo: "2026-01-31",
      }).success,
    ).toBe(false);
  });

  it("accepts equal issued bounds and either bound alone", () => {
    expect(
      list({
        organizationId: ORG,
        issuedFrom: "2026-02-01",
        issuedTo: "2026-02-01",
      }).success,
    ).toBe(true);
    expect(
      list({ organizationId: ORG, issuedFrom: "2026-02-01" }).success,
    ).toBe(true);
    expect(list({ organizationId: ORG, issuedTo: "2026-02-01" }).success).toBe(
      true,
    );
  });

  it.each(["2026-02-30", "2026-13-01", "01-02-2026", "", "yesterday"])(
    "rejects the impossible civil date %j on both bounds",
    (value) => {
      expect(list({ organizationId: ORG, issuedFrom: value }).success).toBe(
        false,
      );
      expect(list({ organizationId: ORG, issuedTo: value }).success).toBe(
        false,
      );
    },
  );

  it("trims q and bounds it to 120 characters", () => {
    expect(list({ organizationId: ORG, q: " acme " }).data?.q).toBe("acme");
    expect(list({ organizationId: ORG, q: "a".repeat(120) }).success).toBe(
      true,
    );
    expect(list({ organizationId: ORG, q: "a".repeat(121) }).success).toBe(
      false,
    );
  });

  it("keeps percent and underscore in q untouched", () => {
    expect(list({ organizationId: ORG, q: "100%_" }).data?.q).toBe("100%_");
  });
});

describe("InvoiceListQuerySchema pagination", () => {
  it.each(["1", "100"])("accepts pageSize %s", (pageSize) => {
    expect(list({ organizationId: ORG, pageSize }).success).toBe(true);
  });

  it.each(["0", "101", "-1", "1.5", "abc"])(
    "rejects pageSize %j",
    (pageSize) => {
      expect(list({ organizationId: ORG, pageSize }).success).toBe(false);
    },
  );

  it("accepts page 10000 and rejects 0, 10001 and non-numbers", () => {
    expect(list({ organizationId: ORG, page: "10000" }).success).toBe(true);
    for (const page of ["0", "10001", "abc", "-1"]) {
      expect(list({ organizationId: ORG, page }).success, page).toBe(false);
    }
  });
});

describe("InvoiceListQuerySchema is strict", () => {
  it.each(["ownerType", "ownerId", "cursor", "limit", "unexpected"])(
    "rejects the unknown or legacy key %s",
    (key) => {
      expect(list({ organizationId: ORG, [key]: "user" }).success).toBe(false);
    },
  );
});

describe("InvoiceTargetQuerySchema (AC-06)", () => {
  it("requires organizationId and treats groupId as optional", () => {
    expect(detail({ organizationId: ORG }).success).toBe(true);
    expect(detail({ organizationId: ORG, groupId: GROUP }).data).toEqual({
      organizationId: ORG,
      groupId: GROUP,
    });
    expect(detail({}).success).toBe(false);
    expect(detail({ groupId: GROUP }).success).toBe(false);
  });

  it.each([
    { organizationId: "nope" },
    { organizationId: ORG, groupId: "nope" },
    { organizationId: ORG, ownerType: "user" },
    { organizationId: ORG, ownerId: "x" },
    { organizationId: ORG, page: "1" },
    { organizationId: ORG, extra: true },
  ])("rejects %j", (query) => {
    expect(detail(query).success).toBe(false);
  });
});

describe("InvoicePageSchema (AC-08)", () => {
  it("accepts a page with group and organization scoped invoices", () => {
    const result = InvoicePageSchema.safeParse({
      items: [INVOICE, { ...INVOICE, groupId: null, groupName: null }],
      page: 1,
      pageSize: 20,
      total: 2,
    });

    expect(result.success).toBe(true);
  });

  it("accepts an empty page", () => {
    expect(
      InvoicePageSchema.safeParse({
        items: [],
        page: 2,
        pageSize: 20,
        total: 0,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["missing total", { items: [], page: 1, pageSize: 20 }],
    ["negative total", { items: [], page: 1, pageSize: 20, total: -1 }],
    [
      "invalid item",
      {
        items: [{ ...INVOICE, amountPesos: "1" }],
        page: 1,
        pageSize: 20,
        total: 1,
      },
    ],
    [
      "item without groupName",
      {
        items: [{ ...INVOICE, groupName: undefined }],
        page: 1,
        pageSize: 20,
        total: 1,
      },
    ],
  ])("rejects a page with %s", (_label, page) => {
    expect(InvoicePageSchema.safeParse(page).success).toBe(false);
  });
});

describe("InvoiceViewSchema groupName", () => {
  it("accepts a group name and null for the organization scope", () => {
    expect(InvoiceViewSchema.safeParse(INVOICE).success).toBe(true);
    expect(
      InvoiceViewSchema.safeParse({
        ...INVOICE,
        groupId: null,
        groupName: null,
      }).success,
    ).toBe(true);
  });

  it.each([undefined, 1, {}])("rejects groupName %j", (groupName) => {
    expect(InvoiceViewSchema.safeParse({ ...INVOICE, groupName }).success).toBe(
      false,
    );
  });

  it("leaves the create/replay Invoice contract without groupName", () => {
    // A stored idempotency snapshot never carries groupName and stays valid.
    const snapshot: Record<string, unknown> = { ...INVOICE };
    delete snapshot.groupName;

    expect(InvoiceSchema.safeParse(snapshot).success).toBe(true);
    expect("groupName" in InvoiceSchema.shape).toBe(false);
  });
});
