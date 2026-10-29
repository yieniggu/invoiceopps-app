import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../auth/password-policy.js";
import {
  paginationQueryShape,
  paginationResponseShape,
} from "../../pagination.js";
import { InvoicePermissionsSchema } from "../groups/permissions-schema.js";
import {
  MembershipSchema,
  RutInputSchema,
  UserSummarySchema,
} from "../orgs/schemas.js";
import { hasNoNul, NO_NUL } from "../../text.js";

export const MAX_GROUPS_PER_USER_CREATION = 200;

const name = z.string().trim().min(1).max(120).refine(hasNoNul, NO_NUL);

/** A group the new user joins, with its own invoice permissions. */
export const GroupGrantSchema = z
  .object({
    groupId: z.string().trim().min(1),
    // Absent means every flag false.
    permissions: InvoicePermissionsSchema.optional(),
  })
  .strict()
  .meta({ id: "GroupGrant" });

/** Rejects a repeated groupId within one list. */
export function uniqueGroupIds(
  groups: ReadonlyArray<{ groupId: string }> | undefined,
  context: z.RefinementCtx,
  path: Array<string | number> = ["groups"],
) {
  const seen = new Set<string>();
  groups?.forEach((group, index) => {
    if (seen.has(group.groupId)) {
      context.addIssue({
        code: "custom",
        message: "Duplicate groupId",
        path: [...path, index, "groupId"],
      });
    }
    seen.add(group.groupId);
  });
}

/** Optional admin-defined temporary password; absent means "generate one". */
export const DefinedTemporaryPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH)
  .max(MAX_PASSWORD_LENGTH)
  .meta({
    description: `Optional temporary password chosen by the administrator (${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} characters). When omitted the server generates one and returns it once. The user must change it at first login.`,
  });

export const UserProvisionRequestSchema = z
  .object({
    name,
    rut: RutInputSchema,
    role: z.enum(OrganizationRole),
    // Absent means every flag false.
    permissions: InvoicePermissionsSchema.optional(),
    // Only groups of this organization; absent means none.
    groups: z
      .array(GroupGrantSchema)
      .max(MAX_GROUPS_PER_USER_CREATION)
      .optional(),
    temporaryPassword: DefinedTemporaryPasswordSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => uniqueGroupIds(request.groups, context))
  .meta({ id: "UserProvisionRequest" });

export const OrganizationUserSchema = UserSummarySchema.extend({
  role: z.enum(OrganizationRole),
}).meta({ id: "OrganizationUser" });

export const OrganizationUserListQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(hasNoNul, NO_NUL)
      .optional()
      .meta({
        description:
          "Case-insensitive part of the name, or part of the RUT typed with or without dots and hyphen (1..100 characters after trimming)",
      }),
    ...paginationQueryShape,
  })
  .strict()
  .meta({ id: "OrganizationUserListQuery" });

export const OrganizationUserListResponseSchema = z
  .object({
    users: z.array(OrganizationUserSchema),
    ...paginationResponseShape,
  })
  .meta({ id: "OrganizationUserListResponse" });

export const GroupGrantResultSchema = z
  .object({ groupId: z.string(), permissions: InvoicePermissionsSchema })
  .meta({ id: "GroupGrantResult" });

export const ProvisionedUserSchema = UserSummarySchema.extend({
  mustChangePassword: z.boolean(),
}).meta({ id: "ProvisionedUser" });

export const TemporaryPasswordSchema = z.string().meta({
  description:
    "Present only when the server generated the password (the request omitted temporaryPassword). Shown once; it is never stored in clear text and never logged.",
});

export const UserProvisionResponseSchema = z
  .object({
    user: ProvisionedUserSchema,
    membership: MembershipSchema,
    groups: z.array(GroupGrantResultSchema),
    temporaryPassword: TemporaryPasswordSchema.optional(),
  })
  .meta({ id: "UserProvisionResponse" });

export const UserBasicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    recentlyActive: z.boolean(),
  })
  .meta({
    id: "UserBasic",
    description:
      "Name and email only: no RUT, credentials, onboarding state, roles or permissions. recentlyActive is false for a disabled user.",
  });

export const SharedOrganizationSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: "SharedOrganization" });

export const UserBasicResponseSchema = z
  .object({
    user: UserBasicSchema,
    sharedOrganizations: z.array(SharedOrganizationSchema),
  })
  .meta({ id: "UserBasicResponse" });

export const UserParamsSchema = z.object({ userId: z.string() });
