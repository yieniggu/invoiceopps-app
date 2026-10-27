import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import { parseRut } from "../../rut.js";

// Legacy platform bodies (RP0-06 and RP0-08 own their final shape); not in
// OpenAPI yet.
const name = z.string().trim().min(1).max(120);
const role = z.enum([OrganizationRole.ADMIN, OrganizationRole.USER]);

export const OrganizationInputSchema = z
  .object({
    name,
    // The slug is validated as sent: it is never trimmed or normalized here.
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z
      .string()
      .trim()
      .max(1_000)
      .transform((value) => value || null)
      .nullable()
      .optional(),
  })
  .strict();

export const ProvisionUserInputSchema = z
  .object({
    name,
    rut: z.string().transform((value, context) => {
      try {
        return parseRut(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid RUT" });
        return z.NEVER;
      }
    }),
    organizationId: z.string().trim().min(1),
    role,
  })
  .strict();

export const MembershipCreateInputSchema = z
  .object({ userId: z.string().trim().min(1), role })
  .strict();

export const MembershipRoleInputSchema = z.object({ role }).strict();
