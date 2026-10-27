import { describe, expect, it } from "vitest";

import {
  canDeleteInvoice,
  capabilitiesFromGroup,
  type GroupInvoiceFlags,
} from "../../src/features/groups/invoice-permissions.js";

const OWN_CREATOR = "user-actor";
const OTHER_CREATOR = "user-someone-else";

// Every combination of the four independent group flags.
const COMBINATIONS: GroupInvoiceFlags[] = Array.from(
  { length: 16 },
  (_unused, bits) => ({
    readInvoices: (bits & 1) !== 0,
    createInvoices: (bits & 2) !== 0,
    deleteOwnInvoices: (bits & 4) !== 0,
    deleteOthersInvoices: (bits & 8) !== 0,
  }),
);

describe("RP0-07 invoice permissions from group flags", () => {
  it("covers all 16 flag combinations", () => {
    expect(
      new Set(COMBINATIONS.map((flags) => JSON.stringify(flags))).size,
    ).toBe(16);
  });

  it.each(COMBINATIONS)(
    "exposes exactly the four flags as capabilities for %j",
    (flags) => {
      expect(capabilitiesFromGroup(flags)).toEqual({
        readInvoices: flags.readInvoices,
        createInvoices: flags.createInvoices,
        deleteOwnInvoices: flags.deleteOwnInvoices,
        deleteOthersInvoices: flags.deleteOthersInvoices,
      });
    },
  );

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
    "implies nothing between flags: read and create never grant delete for %j",
    (flags) => {
      const capabilities = capabilitiesFromGroup(flags);
      // Changing one flag never changes another capability.
      for (const key of Object.keys(capabilities) as Array<
        keyof GroupInvoiceFlags
      >) {
        expect(capabilities[key]).toBe(flags[key]);
      }
      if (!flags.deleteOwnInvoices && !flags.deleteOthersInvoices) {
        expect(canDeleteInvoice(flags, OWN_CREATOR, OWN_CREATOR)).toBe(false);
        expect(canDeleteInvoice(flags, OTHER_CREATOR, OWN_CREATOR)).toBe(false);
      }
    },
  );
});
