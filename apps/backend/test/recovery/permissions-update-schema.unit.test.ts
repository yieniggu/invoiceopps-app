import { describe, expect, it } from "vitest";

import {
  BulkPermissionsUpdateRequestSchema,
  InvoicePermissionsSchema,
  PermissionsUpdateRequestSchema,
} from "../../src/features/groups/permissions-schema.js";

const FOUR = {
  readInvoices: true,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const USER = "5a1b8c2d-4e3f-4a6b-8c7d-9e0f1a2b3c4d";

describe("permissions replacement keeps an omitted deployModels (CR-510)", () => {
  it("leaves deployModels undefined in a PUT body that omits it (not false)", () => {
    const single = PermissionsUpdateRequestSchema.parse({ permissions: FOUR });
    expect(single.permissions.deployModels).toBeUndefined();
    expect(Object.hasOwn(single.permissions, "deployModels")).toBe(false);

    const bulk = BulkPermissionsUpdateRequestSchema.parse({
      userIds: [USER],
      permissions: FOUR,
    });
    expect(bulk.permissions.deployModels).toBeUndefined();
  });

  it("still takes an explicit deployModels, true or false", () => {
    for (const value of [true, false]) {
      expect(
        PermissionsUpdateRequestSchema.parse({
          permissions: { ...FOUR, deployModels: value },
        }).permissions.deployModels,
      ).toBe(value);
    }
  });

  it("still requires the four invoice flags and rejects unknown ones", () => {
    expect(() =>
      PermissionsUpdateRequestSchema.parse({
        permissions: { readInvoices: true },
      }),
    ).toThrow();
    expect(() =>
      PermissionsUpdateRequestSchema.parse({
        permissions: { ...FOUR, extra: true },
      }),
    ).toThrow();
  });

  it("keeps defaulting deployModels to false when a membership is created", () => {
    expect(InvoicePermissionsSchema.parse(FOUR).deployModels).toBe(false);
  });
});
