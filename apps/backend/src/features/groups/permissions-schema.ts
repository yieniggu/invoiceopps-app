import { z } from "zod";

const flag = z.boolean();

/**
 * The five independent flags of one membership (four invoice flags and
 * `deployModels`); none implies another. `deployModels` defaults to false when
 * a CREATE request omits it (a new membership has no history); a PUT
 * replacement uses InvoicePermissionsUpdateSchema, where omitting it means
 * "unchanged".
 */
export const InvoicePermissionsSchema = z
  .object({
    readInvoices: flag,
    createInvoices: flag,
    deleteOwnInvoices: flag,
    deleteOthersInvoices: flag,
    deployModels: flag.default(false),
  })
  .strict()
  .meta({
    id: "InvoicePermissions",
    description:
      "Five independent flags of one membership (readInvoices, createInvoices, deleteOwnInvoices, deleteOthersInvoices and deployModels, which allows deploying registered models); none implies another and no role grants any of them. deployModels may be omitted when a membership is created and then means false; a PUT replacement may omit it and then keeps the current value.",
  });

/**
 * Permissions of a PUT replacement. Same flags, but an omitted `deployModels`
 * means "unchanged" (it is NOT reset to false): a client that predates the flag
 * must not silently revoke it by replacing the four invoice flags.
 */
export const InvoicePermissionsUpdateSchema = z
  .object({
    readInvoices: flag,
    createInvoices: flag,
    deleteOwnInvoices: flag,
    deleteOthersInvoices: flag,
    deployModels: flag.optional(),
  })
  .strict()
  .meta({
    id: "InvoicePermissionsUpdate",
    description:
      "Permissions of a replacement (PUT): the four invoice flags are required and replaced; deployModels is optional and, when omitted, keeps the member's current value (it is not reset to false).",
  });

/** Body of the two PUT .../permissions operations (atomic replace). */
export const PermissionsUpdateRequestSchema = z
  .object({ permissions: InvoicePermissionsUpdateSchema })
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
  .object({
    userIds: BulkUserIdsSchema,
    permissions: InvoicePermissionsUpdateSchema,
  })
  .strict()
  .meta({
    id: "BulkPermissionsUpdateRequest",
    description:
      "Replaces the permissions of every listed member, all or nothing. An omitted deployModels keeps each member's current value.",
  });
