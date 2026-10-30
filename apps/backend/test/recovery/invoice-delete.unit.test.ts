import { describe, expect, it } from "vitest";

import {
  resolveEffectivePermissions,
  type InvoicePermissions,
  type InvoiceScope,
} from "../../src/features/groups/invoice-permissions.js";
import { decideInvoiceDeletion } from "../../src/features/invoices/services.js";

// RP0-12 decision matrix (AC-09, AC-10): who may delete which invoice, and
// when the invoice is invisible (404) instead of forbidden (403). The pure
// decision takes the real group of the invoice, the organization-level flags
// (visibility of a group the actor does not belong to), the effective flags
// of the invoice scope and whether the actor is a member of that group.

const ACTOR = "actor";
const OTHER = "someone-else";
const GROUP = "group-1";

const NONE: InvoicePermissions = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const only = (flags: Partial<InvoicePermissions>): InvoicePermissions => ({
  ...NONE,
  ...flags,
});

interface Case {
  /** Organization membership flags of the actor. */
  org: InvoicePermissions;
  /** Group membership flags; null when the actor is not in the group. */
  group?: InvoicePermissions | null;
  /** Scope of the invoice: a group invoice or an organization invoice. */
  scope: InvoiceScope;
  /** Whether the actor created the invoice. */
  own: boolean;
}

function decide({ org, group = null, scope, own }: Case) {
  const inGroup = scope === "group";
  return decideInvoiceDeletion({
    groupId: inGroup ? GROUP : null,
    organizationPermissions: org,
    effectivePermissions: resolveEffectivePermissions({
      organizationEnabled: true,
      onboardingComplete: true,
      organizationMembership: { permissions: org },
      groupMembership: inGroup && group ? { permissions: group } : null,
      scope,
    }),
    isGroupMember: inGroup && group !== null,
    creatorUserId: own ? ACTOR : OTHER,
    actorUserId: ACTOR,
  });
}

describe("decideInvoiceDeletion: organization-scope invoices (AC-09)", () => {
  it("lets deleteOwn delete an own invoice and not another one", () => {
    const org = only({ deleteOwnInvoices: true });
    expect(decide({ org, scope: "organization", own: true })).toBe("allowed");
    expect(decide({ org, scope: "organization", own: false })).toBe(
      "forbidden",
    );
  });

  it("lets deleteOthers delete another invoice and not an own one without deleteOwn", () => {
    const org = only({ deleteOthersInvoices: true });
    expect(decide({ org, scope: "organization", own: false })).toBe("allowed");
    expect(decide({ org, scope: "organization", own: true })).toBe("forbidden");
  });

  it("allows both when both flags are on", () => {
    const org = only({ deleteOwnInvoices: true, deleteOthersInvoices: true });
    for (const own of [true, false]) {
      expect(decide({ org, scope: "organization", own })).toBe("allowed");
    }
  });

  it("does not let read or create imply any delete flag", () => {
    const org = only({ readInvoices: true, createInvoices: true });
    for (const own of [true, false]) {
      expect(decide({ org, scope: "organization", own })).toBe("forbidden");
    }
  });

  it("does not require read: readInvoices=false never blocks an applicable delete flag", () => {
    const org = only({ readInvoices: false, deleteOwnInvoices: true });
    expect(decide({ org, scope: "organization", own: true })).toBe("allowed");
  });

  it("forbids an organization member without flags (never not-found)", () => {
    for (const own of [true, false]) {
      expect(decide({ org: NONE, scope: "organization", own })).toBe(
        "forbidden",
      );
    }
  });
});

describe("decideInvoiceDeletion: group invoices with a group membership (AC-09)", () => {
  it("allows with the group flag alone", () => {
    expect(
      decide({
        org: NONE,
        group: only({ deleteOwnInvoices: true }),
        scope: "group",
        own: true,
      }),
    ).toBe("allowed");
    expect(
      decide({
        org: NONE,
        group: only({ deleteOthersInvoices: true }),
        scope: "group",
        own: false,
      }),
    ).toBe("allowed");
  });

  it("allows with the organization flag alone (organization OR group)", () => {
    expect(
      decide({
        org: only({ deleteOthersInvoices: true }),
        group: NONE,
        scope: "group",
        own: false,
      }),
    ).toBe("allowed");
  });

  it("keeps deleteOwn and deleteOthers independent inside a group", () => {
    const group = only({ deleteOwnInvoices: true });
    expect(decide({ org: NONE, group, scope: "group", own: false })).toBe(
      "forbidden",
    );
    const others = only({ deleteOthersInvoices: true });
    expect(
      decide({ org: NONE, group: others, scope: "group", own: true }),
    ).toBe("forbidden");
  });

  it("forbids a group member without any applicable flag, never not-found", () => {
    for (const own of [true, false]) {
      expect(decide({ org: NONE, group: NONE, scope: "group", own })).toBe(
        "forbidden",
      );
    }
    // read alone does not grant deletion.
    expect(
      decide({
        org: NONE,
        group: only({ readInvoices: true }),
        scope: "group",
        own: true,
      }),
    ).toBe("forbidden");
  });

  it("does not require read to delete", () => {
    expect(
      decide({
        org: NONE,
        group: only({ deleteOwnInvoices: true, readInvoices: false }),
        scope: "group",
        own: true,
      }),
    ).toBe("allowed");
  });
});

describe("decideInvoiceDeletion: group invoices without a group membership (AC-10)", () => {
  it("is invisible (not-found) when the organization grants neither read nor the applicable delete flag", () => {
    expect(decide({ org: NONE, scope: "group", own: true })).toBe("not-found");
    expect(decide({ org: NONE, scope: "group", own: false })).toBe("not-found");
  });

  it("is not-found when only the non-applicable delete flag is granted", () => {
    expect(
      decide({
        org: only({ deleteOthersInvoices: true }),
        scope: "group",
        own: true,
      }),
    ).toBe("not-found");
    expect(
      decide({
        org: only({ deleteOwnInvoices: true }),
        scope: "group",
        own: false,
      }),
    ).toBe("not-found");
  });

  it("is in scope with organization read but forbidden without the applicable flag", () => {
    for (const own of [true, false]) {
      expect(
        decide({ org: only({ readInvoices: true }), scope: "group", own }),
      ).toBe("forbidden");
    }
    expect(
      decide({
        org: only({ readInvoices: true, deleteOthersInvoices: true }),
        scope: "group",
        own: true,
      }),
    ).toBe("forbidden");
  });

  it("is allowed with the applicable organization delete flag even without read", () => {
    expect(
      decide({
        org: only({ deleteOwnInvoices: true }),
        scope: "group",
        own: true,
      }),
    ).toBe("allowed");
    expect(
      decide({
        org: only({ deleteOthersInvoices: true }),
        scope: "group",
        own: false,
      }),
    ).toBe("allowed");
  });

  it("is allowed with organization read plus the applicable flag", () => {
    expect(
      decide({
        org: only({ readInvoices: true, deleteOthersInvoices: true }),
        scope: "group",
        own: false,
      }),
    ).toBe("allowed");
  });
});

describe("decideInvoiceDeletion: exhaustive matrix against an independent oracle", () => {
  const bools = [false, true];
  type Expected = "allowed" | "forbidden" | "not-found";

  it("agrees for every author x organization flags x group flags x membership x scope", () => {
    let checked = 0;
    for (const scope of ["organization", "group"] as const) {
      for (const own of bools) {
        for (const member of bools) {
          if (scope === "organization" && member) continue;
          for (let o = 0; o < 16; o += 1) {
            for (let g = 0; g < 16; g += 1) {
              if (!member && g > 0) continue;
              const flags = (n: number): InvoicePermissions => ({
                readInvoices: Boolean(n & 1),
                createInvoices: Boolean(n & 2),
                deleteOwnInvoices: Boolean(n & 4),
                deleteOthersInvoices: Boolean(n & 8),
              });
              const org = flags(o);
              const group = member ? flags(g) : null;
              const applicable = (p: InvoicePermissions) =>
                own ? p.deleteOwnInvoices : p.deleteOthersInvoices;

              let expected: Expected;
              if (scope === "organization") {
                expected = applicable(org) ? "allowed" : "forbidden";
              } else if (member) {
                expected =
                  applicable(org) || (group && applicable(group))
                    ? "allowed"
                    : "forbidden";
              } else if (!org.readInvoices && !applicable(org)) {
                expected = "not-found";
              } else {
                expected = applicable(org) ? "allowed" : "forbidden";
              }

              expect(
                decide({ org, group, scope, own }),
                `scope=${scope} own=${own} member=${member} org=${o} group=${g}`,
              ).toBe(expected);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(576);
  });
});
