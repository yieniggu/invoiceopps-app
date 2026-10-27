import { z } from "zod";

// Legacy group bodies (RP0-07 owns their final shape); not in OpenAPI yet.
const name = z.string().trim().min(1).max(120);
// A blank description is stored as null, like an explicit null.
const description = z
  .string()
  .trim()
  .max(1_000)
  .transform((value) => value || null)
  .nullable();

export const GroupInputSchema = z
  .object({ name, description: description.optional() })
  .strict();

export const GroupUpdateSchema = z
  .object({ name: name.optional(), description: description.optional() })
  .strict()
  .refine((update) => Object.keys(update).length > 0, {
    message: "At least one field is required",
    // Unknown or invalid keys already produced an issue.
    when: (payload) => payload.issues.length === 0,
  });

export const GroupMemberInputSchema = z
  .object({ userId: z.string().trim().min(1) })
  .strict();
