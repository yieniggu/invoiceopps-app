import { describe, expect, it } from "vitest";

import {
  canDeleteInvoice,
  NO_INVOICE_PERMISSIONS,
  resolveEffectivePermissions,
  type InvoicePermissions,
} from "../../src/features/groups/invoice-permissions.js";

const OWN_CREATOR = "user-actor";
const OTHER_CREATOR = "user-someone-else";

const KEYS = [
  "readInvoices",
  "createInvoices",
  "deleteOwnInvoices",
  "deleteOthersInvoices",
] as const satisfies ReadonlyArray<keyof InvoicePermissions>;

// Every combination of the four independent flags.
const COMBINATIONS: InvoicePermissions[] = Array.from(
  { length: 16 },
  (_unused, bits) => ({
    readInvoices: (bits & 1) !== 0,
    createInvoices: (bits & 2) !== 0,
    deleteOwnInvoices: (bits & 4) !== 0,
    deleteOthersInvoices: (bits & 8) !== 0,
  }),
);

const ALL_FALSE: InvoicePermissions = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

function or(a: InvoicePermissions, b: InvoicePermissions): InvoicePermissions {
  return {
    readInvoices: a.readInvoices || b.readInvoices,
    createInvoices: a.createInvoices || b.createInvoices,
    deleteOwnInvoices: a.deleteOwnInvoices || b.deleteOwnInvoices,
    deleteOthersInvoices: a.deleteOthersInvoices || b.deleteOthersInvoices,
  };
}

function label(flags: InvoicePermissions) {
  return KEYS.map((key) => (flags[key] ? "1" : "0")).join("");
}

const PAIRS = COMBINATIONS.flatMap((org) =>
  COMBINATIONS.map((group) => ({
    org,
    group,
    title: `org=${label(org)} group=${label(group)}`,
  })),
);

describe("RP0-22 NO_INVOICE_PERMISSIONS", () => {
  it("is all false", () => {
    expect(NO_INVOICE_PERMISSIONS).toEqual(ALL_FALSE);
  });
});

describe("RP0-22 effective permissions in group scope", () => {
  it("covers 16 x 16 flag combinations", () => {
    expect(PAIRS).toHaveLength(256);
    expect(new Set(PAIRS.map((pair) => pair.title)).size).toBe(256);
  });

  it.each(PAIRS)(
    "ORs organization and group flags for $title",
    ({ org, group }) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: { permissions: org },
          groupMembership: { permissions: group },
          scope: "group",
        }),
      ).toEqual(or(org, group));
    },
  );

  it.each(COMBINATIONS)(
    "ignores group flags without a group membership for org=%j",
    (org) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: { permissions: org },
          groupMembership: null,
          scope: "group",
        }),
      ).toEqual(org);
    },
  );
});

describe("RP0-22 effective permissions in organization scope", () => {
  it.each(PAIRS)(
    "uses only organization flags for $title",
    ({ org, group }) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: { permissions: org },
          groupMembership: { permissions: group },
          scope: "organization",
        }),
      ).toEqual(org);
    },
  );

  it.each(COMBINATIONS)(
    "uses only organization flags without a group membership for org=%j",
    (org) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: { permissions: org },
          groupMembership: null,
          scope: "organization",
        }),
      ).toEqual(org);
    },
  );
});

describe("RP0-22 effective permissions gates", () => {
  const ALL_TRUE = COMBINATIONS[15]!;

  it.each(["organization", "group"] as const)(
    "grants nothing without an organization membership in %s scope",
    (scope) => {
      for (const group of COMBINATIONS) {
        expect(
          resolveEffectivePermissions({
            organizationEnabled: true,
            onboardingComplete: true,
            organizationMembership: null,
            groupMembership: { permissions: group },
            scope,
          }),
        ).toEqual(ALL_FALSE);
      }
    },
  );

  it.each(["organization", "group"] as const)(
    "grants nothing when the organization is disabled in %s scope",
    (scope) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: false,
          onboardingComplete: true,
          organizationMembership: { permissions: ALL_TRUE },
          groupMembership: { permissions: ALL_TRUE },
          scope,
        }),
      ).toEqual(ALL_FALSE);
    },
  );

  it.each(["organization", "group"] as const)(
    "grants nothing while onboarding is incomplete in %s scope",
    (scope) => {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: false,
          organizationMembership: { permissions: ALL_TRUE },
          groupMembership: { permissions: ALL_TRUE },
          scope,
        }),
      ).toEqual(ALL_FALSE);
    },
  );

  it("takes no role input: a membership with all flags false resolves to nothing", () => {
    // The input has no role field; an ADMIN is represented only by the flags
    // stored on its membership, so an ADMIN with all flags false gets nothing.
    expect(resolveEffectivePermissions.length).toBe(1);
    const adminMembership = { role: "ADMIN", permissions: ALL_FALSE };
    for (const scope of ["organization", "group"] as const) {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: adminMembership,
          groupMembership: { role: "ADMIN", permissions: ALL_FALSE } as {
            permissions: InvoicePermissions;
          },
          scope,
        }),
      ).toEqual(ALL_FALSE);
    }
  });

  it.each(KEYS)("treats %s independently: no other flag is implied", (key) => {
    const only: InvoicePermissions = { ...ALL_FALSE, [key]: true };
    for (const scope of ["organization", "group"] as const) {
      expect(
        resolveEffectivePermissions({
          organizationEnabled: true,
          onboardingComplete: true,
          organizationMembership: { permissions: only },
          groupMembership: null,
          scope,
        }),
      ).toEqual(only);
    }
  });
});

describe("RP0-22 canDeleteInvoice", () => {
  it.each(COMBINATIONS)(
    "deletes an own invoice only with deleteOwnInvoices for %j",
    (flags) => {
      expect(canDeleteInvoice(flags, OWN_CREATOR, OWN_CREATOR)).toBe(
        flags.deleteOwnInvoices,
      );
    },
  );

  it.each(COMBINATIONS)(
    "deletes another person's invoice only with deleteOthersInvoices for %j",
    (flags) => {
      expect(canDeleteInvoice(flags, OTHER_CREATOR, OWN_CREATOR)).toBe(
        flags.deleteOthersInvoices,
      );
    },
  );

  it.each(COMBINATIONS)(
    "never lets read or create grant delete for %j",
    (flags) => {
      if (!flags.deleteOwnInvoices && !flags.deleteOthersInvoices) {
        expect(canDeleteInvoice(flags, OWN_CREATOR, OWN_CREATOR)).toBe(false);
        expect(canDeleteInvoice(flags, OTHER_CREATOR, OWN_CREATOR)).toBe(false);
      }
    },
  );
});
