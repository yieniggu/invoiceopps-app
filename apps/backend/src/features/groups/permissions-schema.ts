import { z } from "zod";

const flag = z.boolean();

/** The four independent invoice flags of one membership; none implies another. */
export const InvoicePermissionsSchema = z
  .object({
    readInvoices: flag,
    createInvoices: flag,
    deleteOwnInvoices: flag,
    deleteOthersInvoices: flag,
  })
  .strict()
  .meta({
    id: "InvoicePermissions",
    description:
      "Four independent invoice flags of one membership; none implies another and no role grants any of them.",
  });

/** Body of the two PUT .../permissions operations (atomic replace). */
export const PermissionsUpdateRequestSchema = z
  .object({ permissions: InvoicePermissionsSchema })
  .strict()
  .meta({ id: "PermissionsUpdateRequest" });

/** Distinct user ids of a bulk operation (at most 200). */
const BulkUserIdsSchema = z
  .array(z.uuid())
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "userIds must be unique",
  });

/** Body of the two bulk PUT .../memberships/permissions operations. */
export const BulkPermissionsUpdateRequestSchema = z
  .object({ userIds: BulkUserIdsSchema, permissions: InvoicePermissionsSchema })
  .strict()
  .meta({
    id: "BulkPermissionsUpdateRequest",
    description:
      "Replaces the four invoice permissions of every listed member, all or nothing.",
  });
