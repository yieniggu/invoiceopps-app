import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Response } from "../support/request.js";
import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { InvoiceViewSchema } from "../../src/features/invoices/schemas.js";
import type { InvoiceView as Invoice } from "../../src/features/invoices/types.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  type TestUser,
} from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const {
  makeUser,
  makeOrg,
  join,
  makeGroup,
  addToGroup,
  cookieFor,
  call,
  designatePlatformAdministrator,
  scenario,
} = membershipFixtures({ prisma, client, auth, app, url });

const MISSING = "00000000-0000-4000-8000-000000000000";
const READ_ONLY = { ...NO_FLAGS, readInvoices: true };
const CREATE_AND_READ = {
  ...NO_FLAGS,
  createInvoices: true,
  readInvoices: true,
};

interface SeedOptions {
  groupId?: string | null;
  businessStatus?: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  supplierName?: string;
  businessId?: string;
  issuedOn?: string;
  createdAt?: Date;
  deleted?: boolean;
}

let clock = 0;
const nextCreatedAt = () => new Date(Date.UTC(2026, 5, 1, 12, (clock += 1)));

/** Inserts an invoice row directly; reads never depend on the create path. */
async function seed(
  organizationId: string,
  createdByUserId: string,
  options: SeedOptions = {},
) {
  const groupId = options.groupId ?? null;
  const issued = options.issuedOn ?? "2026-01-15";
  return prisma.invoice.create({
    data: {
      organizationId,
      groupId,
      scopeKey: groupId ?? "organization",
      businessId: options.businessId ?? `FAC-${randomUUID()}`,
      supplierName: options.supplierName ?? "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: new Date(`${issued}T00:00:00.000Z`),
      dueOn: new Date("2027-01-15T00:00:00.000Z"),
      businessStatus: options.businessStatus ?? "PENDING",
      createdByUserId,
      createdAt: options.createdAt ?? nextCreatedAt(),
      ...(options.deleted
        ? { deletedAt: new Date(), deletedByUserId: createdByUserId }
        : {}),
    },
  });
}

const listPath = (params: Record<string, string>) =>
  `/invoices?${new URLSearchParams(params).toString()}`;

const idsOf = (body: { items: Invoice[] }) => body.items.map((item) => item.id);
const sorted = (values: string[]) => [...values].sort();

// World shared by the read-only suites (nothing below mutates it).
let orgA: { id: string };
let orgB: { id: string };
let g1: { id: string };
let g2: { id: string };
let gB: { id: string };
let orgReader: TestUser;
let g1Reader: TestUser;
let noRead: TestUser;
let hiddenMember: TestUser;
let outsider: TestUser;
let creator: TestUser;
let platform: TestUser;
let platformCookie: string;
let cookies: Record<
  "orgReader" | "g1Reader" | "noRead" | "hiddenMember" | "outsider",
  string
>;
// Seeded rows, by name.
const row: Record<string, Invoice["id"]> = {};

beforeAll(async () => {
  await client.connect();
  platform = await makeUser("Platform Administrator");
  await designatePlatformAdministrator(platform.id);
  platformCookie = await cookieFor(platform);
  orgA = await makeOrg("read-a");
  orgB = await makeOrg("read-b");
  g1 = await makeGroup(orgA.id, "G1");
  g2 = await makeGroup(orgA.id, "G2");
  gB = await makeGroup(orgB.id, "GB");
  [orgReader, g1Reader, noRead, hiddenMember, outsider, creator] =
    await Promise.all([
      makeUser("Org Reader"),
      makeUser("G1 Reader"),
      makeUser("No Read"),
      makeUser("Hidden Member"),
      makeUser("Outsider"),
      makeUser("Creator"),
    ]);
  await join(creator.id, orgA.id, "ADMIN", ALL_FLAGS);
  await join(creator.id, orgB.id, "ADMIN", ALL_FLAGS);
  await join(orgReader.id, orgA.id, "USER", READ_ONLY);
  // Group-level read only: no organization flags, member of G1.
  await join(g1Reader.id, orgA.id, "USER", NO_FLAGS);
  await addToGroup(g1.id, g1Reader.id, orgA.id, READ_ONLY);
  // Member of G2 without any read flag.
  await join(noRead.id, orgA.id, "USER", NO_FLAGS);
  await addToGroup(g2.id, noRead.id, orgA.id, NO_FLAGS);
  // Organization member in no group and without read.
  await join(hiddenMember.id, orgA.id, "USER", NO_FLAGS);

  // Dates: O1 01-10, A1 01-31, A2 02-05, O2 02-10, B1 02-20, O3 03-10.
  const make = async (name: string, options: SeedOptions, scope: string) => {
    const created = await seed(
      scope === "B" ? orgB.id : orgA.id,
      creator.id,
      options,
    );
    row[name] = created.id;
  };
  await make(
    "O1",
    { supplierName: "Acme Ltda", issuedOn: "2026-01-10", businessId: "FAC-O1" },
    "A",
  );
  await make(
    "A1",
    {
      groupId: g1.id,
      supplierName: "100% Organic",
      issuedOn: "2026-01-31",
      businessId: "G1-001",
    },
    "A",
  );
  await make(
    "A2",
    {
      groupId: g1.id,
      supplierName: "Under_score Co",
      issuedOn: "2026-02-05",
      businessStatus: "REJECTED",
      businessId: "FAC-A2",
    },
    "A",
  );
  await make(
    "O2",
    {
      supplierName: "Beta SpA",
      issuedOn: "2026-02-10",
      businessStatus: "APPROVED",
      businessId: "FAC-O2",
    },
    "A",
  );
  await make(
    "B1",
    {
      groupId: g2.id,
      supplierName: "Gamma",
      issuedOn: "2026-02-20",
      businessId: "FAC-B1",
    },
    "A",
  );
  await make(
    "O3",
    {
      supplierName: "Delta",
      issuedOn: "2026-03-10",
      businessStatus: "CANCELLED",
      businessId: "FAC-O3",
    },
    "A",
  );
  await make(
    "D1",
    {
      groupId: g1.id,
      deleted: true,
      businessId: "FAC-D1",
      supplierName: "Gone",
    },
    "A",
  );
  await make("D2", { deleted: true, businessId: "FAC-D2" }, "A");
  await make("X1", { businessId: "FAC-X1" }, "B");

  cookies = {
    orgReader: await cookieFor(orgReader),
    g1Reader: await cookieFor(g1Reader),
    noRead: await cookieFor(noRead),
    hiddenMember: await cookieFor(hiddenMember),
    outsider: await cookieFor(outsider),
  };
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const ACTIVE_A = () => [row.O1, row.A1, row.A2, row.O2, row.B1, row.O3];

async function listAs(
  cookie: string | undefined,
  params: Record<string, string>,
) {
  return call("get", listPath(params), cookie);
}

describe("RP0-11 list by organization (AC-01)", () => {
  it("returns every active invoice of the organization, grouped or not", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });

    expect(response.status).toBe(200);
    expect(sorted(idsOf(response.body))).toEqual(sorted(ACTIVE_A()));
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 6 });
  });

  it("never returns another organization's invoices", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });

    expect(idsOf(response.body)).not.toContain(row.X1);
  });

  it("answers 403 FORBIDDEN to an organization member without organization read", async () => {
    for (const cookie of [
      cookies.noRead,
      cookies.hiddenMember,
      // Group-level read does not grant the organization-wide listing.
      cookies.g1Reader,
    ]) {
      const response = await listAs(cookie, { organizationId: orgA.id });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("answers 404 NOT_FOUND to a non-member and for an unknown organization", async () => {
    for (const organizationId of [orgA.id, MISSING]) {
      const response = await listAs(cookies.outsider, { organizationId });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("answers 401 without a session", async () => {
    const response = await listAs(undefined, { organizationId: orgA.id });

    expect(response.status).toBe(401);
  });
});

describe("RP0-11 platform administrator has no implicit invoice access (CR-333)", () => {
  it("answers 404 to the platform administrator on the list, like a non-member", async () => {
    const asPlatform = await listAs(platformCookie, {
      organizationId: orgA.id,
    });
    const asOutsider = await listAs(cookies.outsider, {
      organizationId: orgA.id,
    });

    expect(asPlatform.status).toBe(404);
    expect(asPlatform.body).toEqual(asOutsider.body);
  });

  it("answers 404 to the platform administrator on the detail, like a non-member", async () => {
    const path = `/invoices/${row.O1}?organizationId=${orgA.id}`;
    const asPlatform = await call("get", path, platformCookie);
    const asOutsider = await call("get", path, cookies.outsider);

    expect(asPlatform.status).toBe(404);
    expect(asPlatform.body).toEqual(asOutsider.body);
  });
});

describe("RP0-11 list by group (AC-02)", () => {
  it("returns only the invoices of that group to an organization reader", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      groupId: g1.id,
    });

    expect(response.status).toBe(200);
    expect(sorted(idsOf(response.body))).toEqual(sorted([row.A1, row.A2]));
    expect(response.body.total).toBe(2);
  });

  it("lets a group-level reader list its group", async () => {
    const response = await listAs(cookies.g1Reader, {
      organizationId: orgA.id,
      groupId: g1.id,
    });

    expect(response.status).toBe(200);
    expect(sorted(idsOf(response.body))).toEqual(sorted([row.A1, row.A2]));
  });

  it("answers 404 for a group of another organization", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      groupId: gB.id,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for an unknown group", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      groupId: MISSING,
    });

    expect(response.status).toBe(404);
  });

  it("hides a group from an organization member who is not in it and lacks organization read", async () => {
    for (const [cookie, groupId] of [
      [cookies.hiddenMember, g1.id],
      [cookies.g1Reader, g2.id],
    ] as const) {
      const response = await listAs(cookie, {
        organizationId: orgA.id,
        groupId,
      });

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("answers 403 to a group member without effective read", async () => {
    const response = await listAs(cookies.noRead, {
      organizationId: orgA.id,
      groupId: g2.id,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 to a non-member of the organization", async () => {
    const response = await listAs(cookies.outsider, {
      organizationId: orgA.id,
      groupId: g1.id,
    });

    expect(response.status).toBe(404);
  });
});

describe("RP0-11 list ungrouped (AC-03)", () => {
  it("returns only invoices without a group to an organization reader", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      ungrouped: "true",
    });

    expect(response.status).toBe(200);
    expect(sorted(idsOf(response.body))).toEqual(
      sorted([row.O1, row.O2, row.O3]),
    );
    expect(response.body.total).toBe(3);
    for (const item of response.body.items as Invoice[]) {
      expect(item.groupId).toBeNull();
    }
  });

  it("treats ungrouped=false like an absent flag", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      ungrouped: "false",
    });

    expect(response.status).toBe(200);
    expect(sorted(idsOf(response.body))).toEqual(sorted(ACTIVE_A()));
  });

  it("answers 403 when the actor lacks organization read, even with group read", async () => {
    for (const cookie of [cookies.g1Reader, cookies.noRead]) {
      const response = await listAs(cookie, {
        organizationId: orgA.id,
        ungrouped: "true",
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("rejects groupId together with ungrouped=true", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      groupId: g1.id,
      ungrouped: "true",
    });

    expect(response.status).toBe(400);
  });
});

describe("RP0-11 list filters (AC-04)", () => {
  const filtered = async (params: Record<string, string>) => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
      ...params,
    });
    expect(response.status).toBe(200);
    return response.body as { items: Invoice[]; total: number };
  };

  it("filters by businessStatus and never mixes CANCELLED into PENDING", async () => {
    const pending = await filtered({ businessStatus: "PENDING" });
    const cancelled = await filtered({ businessStatus: "CANCELLED" });

    expect(sorted(idsOf(pending))).toEqual(sorted([row.O1, row.A1, row.B1]));
    expect(idsOf(pending)).not.toContain(row.O3);
    expect(idsOf(cancelled)).toEqual([row.O3]);
    expect(idsOf(await filtered({ businessStatus: "APPROVED" }))).toEqual([
      row.O2,
    ]);
    expect(idsOf(await filtered({ businessStatus: "REJECTED" }))).toEqual([
      row.A2,
    ]);
  });

  it("applies issuedFrom and issuedTo inclusively", async () => {
    const both = await filtered({
      issuedFrom: "2026-01-10",
      issuedTo: "2026-01-31",
    });
    const fromOnly = await filtered({ issuedFrom: "2026-02-10" });
    const toOnly = await filtered({ issuedTo: "2026-01-10" });
    const single = await filtered({
      issuedFrom: "2026-02-05",
      issuedTo: "2026-02-05",
    });

    expect(sorted(idsOf(both))).toEqual(sorted([row.O1, row.A1]));
    expect(sorted(idsOf(fromOnly))).toEqual(sorted([row.O2, row.B1, row.O3]));
    expect(idsOf(toOnly)).toEqual([row.O1]);
    expect(idsOf(single)).toEqual([row.A2]);
  });

  it("searches supplierName and businessId case-insensitively", async () => {
    expect(idsOf(await filtered({ q: "acme" }))).toEqual([row.O1]);
    expect(idsOf(await filtered({ q: "ACME LTDA" }))).toEqual([row.O1]);
    // businessId "G1-001" is matched through its lowercase form.
    expect(idsOf(await filtered({ q: "g1-001" }))).toEqual([row.A1]);
    expect(idsOf(await filtered({ q: "  gamma  " }))).toEqual([row.B1]);
  });

  it("takes % and _ in q literally", async () => {
    expect(idsOf(await filtered({ q: "%" }))).toEqual([row.A1]);
    expect(idsOf(await filtered({ q: "100%" }))).toEqual([row.A1]);
    expect(idsOf(await filtered({ q: "_" }))).toEqual([row.A2]);
    expect(idsOf(await filtered({ q: "under_" }))).toEqual([row.A2]);
    expect(await filtered({ q: "%%" })).toMatchObject({ items: [], total: 0 });
  });

  it("combines filters with the group scope and counts with the same predicate", async () => {
    const result = await filtered({
      groupId: g1.id,
      businessStatus: "PENDING",
    });

    expect(idsOf(result)).toEqual([row.A1]);
    expect(result.total).toBe(1);
  });
});

describe("RP0-11 pagination and ordering (AC-05)", () => {
  it("pages a stable order, counts the same predicate and excludes deleted rows", async () => {
    const pager = await makeOrg("read-pager");
    await join(creator.id, pager.id, "ADMIN", ALL_FLAGS);
    const reader = await makeUser("Pager Reader");
    await join(reader.id, pager.id, "USER", READ_ONLY);
    const cookie = await cookieFor(reader);
    const oldest = new Date(Date.UTC(2026, 0, 1, 0, 0));
    const tied = new Date(Date.UTC(2026, 0, 2, 0, 0));
    const newest = new Date(Date.UTC(2026, 0, 3, 0, 0));
    const created = [
      await seed(pager.id, creator.id, { createdAt: oldest }),
      await seed(pager.id, creator.id, { createdAt: oldest }),
      await seed(pager.id, creator.id, { createdAt: tied }),
      await seed(pager.id, creator.id, { createdAt: tied }),
      await seed(pager.id, creator.id, { createdAt: tied }),
      await seed(pager.id, creator.id, { createdAt: newest }),
    ];
    await seed(pager.id, creator.id, { createdAt: newest, deleted: true });
    const expected = [...created]
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          (left.id < right.id ? 1 : -1),
      )
      .map((invoice) => invoice.id);

    const pages = [];
    for (const page of [1, 2, 3]) {
      const response = await listAs(cookie, {
        organizationId: pager.id,
        pageSize: "2",
        page: String(page),
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ page, pageSize: 2, total: 6 });
      pages.push(...idsOf(response.body));
    }
    const beyond = await listAs(cookie, {
      organizationId: pager.id,
      pageSize: "2",
      page: "4",
    });

    expect(pages).toEqual(expected);
    expect(new Set(pages).size).toBe(6);
    expect(beyond.status).toBe(200);
    expect(beyond.body).toMatchObject({ items: [], page: 4, total: 6 });
  });

  it("orders newer invoices first", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });
    const stamps = (response.body.items as Invoice[]).map((item) =>
      Date.parse(item.createdAt),
    );

    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });

  it("excludes deleted invoices from items and total", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });

    expect(idsOf(response.body)).not.toContain(row.D1);
    expect(idsOf(response.body)).not.toContain(row.D2);
    expect(response.body.total).toBe(6);
  });
});

describe("RP0-11 invoice detail (AC-06)", () => {
  const detailPath = (id: string, organizationId: string, groupId?: string) => {
    const query = new URLSearchParams({ organizationId });
    if (groupId) query.set("groupId", groupId);
    return `/invoices/${id}?${query.toString()}`;
  };

  it("returns an organization-scoped invoice to an organization reader", async () => {
    const response = await call(
      "get",
      detailPath(row.O1!, orgA.id),
      cookies.orgReader,
    );

    expect(response.status).toBe(200);
    expect(response.body.invoice).toMatchObject({
      id: row.O1,
      organizationId: orgA.id,
      groupId: null,
      businessId: "FAC-O1",
    });
  });

  it("returns a group invoice with its groupId to organization and group readers", async () => {
    for (const cookie of [cookies.orgReader, cookies.g1Reader]) {
      const response = await call(
        "get",
        detailPath(row.A1!, orgA.id, g1.id),
        cookie,
      );

      expect(response.status).toBe(200);
      expect(response.body.invoice).toMatchObject({
        id: row.A1,
        groupId: g1.id,
      });
    }
  });

  it("returns a group invoice requested without groupId when the actor may read it", async () => {
    for (const cookie of [cookies.orgReader, cookies.g1Reader]) {
      const response = await call("get", detailPath(row.A1!, orgA.id), cookie);

      expect(response.status).toBe(200);
      expect(response.body.invoice).toMatchObject({
        id: row.A1,
        groupId: g1.id,
      });
    }
  });

  it("keeps hiding a group invoice requested without groupId from members who cannot see the group", async () => {
    const hidden = await call(
      "get",
      detailPath(row.A1!, orgA.id),
      cookies.hiddenMember,
    );
    const noReadMember = await call(
      "get",
      detailPath(row.B1!, orgA.id),
      cookies.noRead,
    );

    expect(hidden.status).toBe(404);
    expect(noReadMember.status).toBe(403);
  });

  it("answers the same 404 body for every invisible or mismatched invoice", async () => {
    const unknown = await call(
      "get",
      detailPath(MISSING, orgA.id),
      cookies.orgReader,
    );
    const cases: Array<[string, PromiseLike<Response>]> = [
      [
        "another organization's invoice",
        call("get", detailPath(row.X1!, orgA.id), cookies.orgReader),
      ],
      [
        "the right invoice in an organization the actor is not in",
        call("get", detailPath(row.X1!, orgB.id), cookies.orgReader),
      ],
      [
        "a group invoice asked under another group",
        call("get", detailPath(row.A1!, orgA.id, g2.id), cookies.orgReader),
      ],
      [
        "an organization invoice asked under a group",
        call("get", detailPath(row.O1!, orgA.id, g1.id), cookies.orgReader),
      ],
      [
        "a group invoice the actor cannot see",
        call("get", detailPath(row.A1!, orgA.id, g1.id), cookies.hiddenMember),
      ],
      [
        "an invoice asked by a non-member",
        call("get", detailPath(row.O1!, orgA.id), cookies.outsider),
      ],
      [
        "a deleted group invoice",
        call("get", detailPath(row.D1!, orgA.id, g1.id), cookies.orgReader),
      ],
      [
        "a deleted organization invoice",
        call("get", detailPath(row.D2!, orgA.id), cookies.orgReader),
      ],
    ];

    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    for (const [label, pending] of cases) {
      const response = await pending;
      expect(response.status, label).toBe(404);
      expect(response.body, label).toEqual(unknown.body);
    }
  });

  it("answers 403 to an in-scope member without read", async () => {
    const orgScope = await call(
      "get",
      detailPath(row.O1!, orgA.id),
      cookies.noRead,
    );
    const ownGroup = await call(
      "get",
      detailPath(row.B1!, orgA.id, g2.id),
      cookies.noRead,
    );
    const orgScopeFromGroupReader = await call(
      "get",
      detailPath(row.O1!, orgA.id),
      cookies.g1Reader,
    );

    for (const response of [orgScope, ownGroup, orgScopeFromGroupReader]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it.each([
    ["a NUL byte", "%00"],
    ["a non-uuid string", "not-a-uuid"],
  ])(
    "answers the same 404 body for an invoiceId that is %s (CR-327)",
    async (_label, id) => {
      const unknown = await call(
        "get",
        detailPath(MISSING, orgA.id),
        cookies.orgReader,
      );
      const response = await call(
        "get",
        `/invoices/${id}?organizationId=${orgA.id}`,
        cookies.orgReader,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual(unknown.body);
    },
  );

  it("answers 400 for a malformed query before touching data", async () => {
    const response = await call(
      "get",
      `/invoices/${row.O1}?organizationId=nope`,
      cookies.orgReader,
    );

    expect(response.status).toBe(400);
  });
});

describe("RP0-11 organization state and revocation (AC-07)", () => {
  it("answers 403 to the members of a disabled organization", async () => {
    const s = await scenario();
    await join(creator.id, s.org.id, "ADMIN", ALL_FLAGS);
    const reader = await makeUser("Disabled Reader");
    await join(reader.id, s.org.id, "USER", READ_ONLY);
    const invoice = await seed(s.org.id, creator.id);
    const cookie = await cookieFor(reader);
    expect((await listAs(cookie, { organizationId: s.org.id })).status).toBe(
      200,
    );

    await prisma.organization.update({
      where: { id: s.org.id },
      data: { enabled: false },
    });

    const listed = await listAs(cookie, { organizationId: s.org.id });
    const fetched = await call(
      "get",
      `/invoices/${invoice.id}?organizationId=${s.org.id}`,
      cookie,
    );
    expect(listed.status).toBe(403);
    expect(fetched.status).toBe(403);
    expect(listed.body.error.code).toBe("FORBIDDEN");
  });

  it("takes effect on the next request after the organization flag is revoked", async () => {
    const s = await scenario();
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: READ_ONLY,
    });
    const invoice = await seed(s.org.id, s.admin.id);
    const cookie = await cookieFor(s.member);
    const adminCookie = await cookieFor(s.admin);
    const detail = `/invoices/${invoice.id}?organizationId=${s.org.id}`;
    expect((await call("get", detail, cookie)).status).toBe(200);
    expect((await listAs(cookie, { organizationId: s.org.id })).status).toBe(
      200,
    );

    const revoke = await call(
      "put",
      `/organizations/${s.org.id}/memberships/${s.member.id}/permissions`,
      adminCookie,
      { permissions: NO_FLAGS },
    );

    expect(revoke.status).toBe(200);
    expect((await call("get", detail, cookie)).status).toBe(403);
    expect((await listAs(cookie, { organizationId: s.org.id })).status).toBe(
      403,
    );
  });

  it("takes effect on the next request after the group flag is revoked", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.member.id, s.org.id, READ_ONLY);
    const invoice = await seed(s.org.id, s.admin.id, { groupId: s.group.id });
    const cookie = await cookieFor(s.member);
    const adminCookie = await cookieFor(s.admin);
    const detail = `/invoices/${invoice.id}?organizationId=${s.org.id}&groupId=${s.group.id}`;
    const listing = { organizationId: s.org.id, groupId: s.group.id };
    expect((await call("get", detail, cookie)).status).toBe(200);
    expect((await listAs(cookie, listing)).status).toBe(200);

    const revoke = await call(
      "put",
      `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${s.member.id}/permissions`,
      adminCookie,
      { permissions: NO_FLAGS },
    );

    expect(revoke.status).toBe(200);
    expect((await call("get", detail, cookie)).status).toBe(403);
    expect((await listAs(cookie, listing)).status).toBe(403);
  });
});

describe("RP0-11 response DTO (AC-08)", () => {
  const DTO_KEYS = Object.keys(InvoiceViewSchema.shape).sort();

  it("serializes exactly the InvoiceViewSchema keys for group and organization invoices", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });

    expect(response.status).toBe(200);
    const items = response.body.items as Invoice[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(DTO_KEYS);
      expect(InvoiceViewSchema.safeParse(item).success).toBe(true);
    }
    expect(items.some((item) => item.groupId === null)).toBe(true);
    expect(items.some((item) => item.groupId !== null)).toBe(true);
  });

  it("never leaks storage fields in the list or the detail", async () => {
    const listed = await listAs(cookies.orgReader, { organizationId: orgA.id });
    const fetched = await call(
      "get",
      `/invoices/${row.O1}?organizationId=${orgA.id}`,
      cookies.orgReader,
    );
    const text = JSON.stringify([listed.body, fetched.body]);

    for (const field of ["scopeKey", "deletedAt", "deletedByUserId"]) {
      expect(text).not.toContain(field);
    }
    expect(Object.keys(fetched.body.invoice).sort()).toEqual(DTO_KEYS);
  });

  it("maps civil dates without a timezone shift and createdAt as ISO", async () => {
    const response = await call(
      "get",
      `/invoices/${row.A1}?organizationId=${orgA.id}&groupId=${g1.id}`,
      cookies.orgReader,
    );

    expect(response.body.invoice).toMatchObject({
      issuedOn: "2026-01-31",
      dueOn: "2027-01-15",
      processingStatus: "NOT_REQUESTED",
      createdByUserId: creator.id,
    });
  });
});

describe("RP0-11 groupName in the read DTO", () => {
  it("names the group of every grouped item and is null for organization scope", async () => {
    const response = await listAs(cookies.orgReader, {
      organizationId: orgA.id,
    });

    const names = Object.fromEntries(
      (response.body.items as Invoice[]).map((item) => [
        item.id,
        item.groupName,
      ]),
    );
    expect(names[row.O1!]).toBeNull();
    expect(names[row.A1!]).toBe("G1");
    expect(names[row.B1!]).toBe("G2");
  });

  it("names the group to a reader who is not a member of it (organization read)", async () => {
    // orgReader has no group membership at all.
    const response = await call(
      "get",
      `/invoices/${row.B1}?organizationId=${orgA.id}`,
      cookies.orgReader,
    );

    expect(response.status).toBe(200);
    expect(response.body.invoice).toMatchObject({
      groupId: g2.id,
      groupName: "G2",
    });
  });

  it("returns groupName null on the organization-scoped detail", async () => {
    const response = await call(
      "get",
      `/invoices/${row.O1}?organizationId=${orgA.id}`,
      cookies.orgReader,
    );

    expect(response.body.invoice.groupName).toBeNull();
  });
});

describe("RP0-11 Location of the create resolves to the same invoice (CR-320)", () => {
  it.each(["group", "organization"] as const)(
    "resolves the %s-scoped Location through GET detail",
    async (scope) => {
      const s = await scenario();
      await prisma.organizationMembership.update({
        where: {
          userId_organizationId: {
            userId: s.member.id,
            organizationId: s.org.id,
          },
        },
        data: CREATE_AND_READ,
      });
      const cookie = await cookieFor(s.member);

      const created = await call("post", "/invoices", cookie, {
        organizationId: s.org.id,
        ...(scope === "group" ? { groupId: s.group.id } : {}),
        businessId: `FAC-${randomUUID()}`,
        supplierName: "Proveedor local",
        amountPesos: 12500,
        currency: "CLP",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        businessStatus: "PENDING",
      }).set("Idempotency-Key", `key-${randomUUID()}`);
      expect(created.status).toBe(201);

      const location = created.headers.location as string;
      const fetched = await call(
        "get",
        location.replace(/^\/api\/v1/, ""),
        cookie,
      );

      expect(fetched.status).toBe(200);
      expect(created.body.invoice).not.toHaveProperty("groupName");
      expect(fetched.body).toEqual({
        invoice: {
          ...created.body.invoice,
          groupName: scope === "group" ? "Finance" : null,
        },
      });
    },
  );
});
