import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import {
  paginationQueryShape,
  paginationResponseShape,
} from "../../pagination.js";
import { InvoicePermissionsSchema } from "../groups/permissions-schema.js";
import { NameSchema, RutInputSchema } from "../orgs/schemas.js";
import {
  DefinedTemporaryPasswordSchema,
  GroupGrantResultSchema,
  GroupGrantSchema,
  MAX_GROUPS_PER_USER_CREATION,
  ProvisionedUserSchema,
  TemporaryPasswordSchema,
  uniqueGroupIds,
} from "../users/schemas.js";
import { hasNoNul, NO_NUL } from "../../text.js";

export const MAX_ORGANIZATIONS_PER_USER_CREATION = 50;

/**
 * Group grants of one creation, summed over every membership. Without it the
 * schema maxima (50 organizations x 200 groups) allow 10,000 grants, which
 * cannot travel in the 64 kB body of this route (about 400 fit). 200 matches
 * the other bulk caps; a body at every other maximum (50 organizations, all
 * flags, 120-character name, 256-character password, UUIDs) measures about
 * 42 kB, so a valid request always fits.
 */
export const MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION = 200;

export const AdminUserMembershipGrantSchema = z
  .object({
    organizationId: z.string().trim().min(1),
    role: z.enum(OrganizationRole),
    // Absent means every flag false.
    permissions: InvoicePermissionsSchema.optional(),
    // Only groups of this organization; absent means none.
    groups: z
      .array(GroupGrantSchema)
      .max(MAX_GROUPS_PER_USER_CREATION)
      .optional(),
  })
  .strict()
  .superRefine((membership, context) =>
    uniqueGroupIds(membership.groups, context),
  )
  .meta({ id: "AdminUserMembershipGrant" });

export const AdminUserCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).refine(hasNoNul, NO_NUL),
    rut: RutInputSchema,
    memberships: z
      .array(AdminUserMembershipGrantSchema)
      .max(MAX_ORGANIZATIONS_PER_USER_CREATION),
    temporaryPassword: DefinedTemporaryPasswordSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const grants = request.memberships.reduce(
      (total, { groups }) => total + (groups?.length ?? 0),
      0,
    );
    if (grants > MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION) {
      context.addIssue({
        code: "custom",
        message: `At most ${MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION} group grants in total across all memberships`,
        path: ["memberships"],
      });
    }
    const seen = new Set<string>();
    request.memberships.forEach((membership, index) => {
      if (seen.has(membership.organizationId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate organizationId",
          path: ["memberships", index, "organizationId"],
        });
      }
      seen.add(membership.organizationId);
    });
  })
  .meta({
    id: "AdminUserCreateRequest",
    description: `At most ${MAX_ORGANIZATIONS_PER_USER_CREATION} memberships and ${MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION} group grants in total across all of them (the 64 kB body limit is sized for that maximum).`,
  });

export const AdminUserMembershipSchema = z
  .object({
    organizationId: z.string(),
    role: z.enum(OrganizationRole),
    permissions: InvoicePermissionsSchema,
    groups: z.array(GroupGrantResultSchema),
  })
  .meta({ id: "AdminUserMembership" });

export const AdminUserCreateResponseSchema = z
  .object({
    user: ProvisionedUserSchema,
    memberships: z.array(AdminUserMembershipSchema),
    temporaryPassword: TemporaryPasswordSchema.optional(),
  })
  .meta({ id: "AdminUserCreateResponse" });

export const AdminUserParamsSchema = z.object({ userId: z.string() });

export const AdminUserDeactivationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rut: z.string(),
    // Null while the user is enabled.
    disabledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: "AdminUserDeactivation" });

export const AdminUserDeactivationResponseSchema = z
  .object({ user: AdminUserDeactivationSchema })
  .meta({ id: "AdminUserDeactivationResponse" });

export const AdminUserStatusSchema = z.enum(["all", "active", "disabled"]);

export const AdminUserListQuerySchema = z
  .object({
    search: NameSchema.optional().meta({
      description:
        "Case-insensitive part of the name, or part of the RUT typed with or without dots and hyphen",
    }),
    status: AdminUserStatusSchema.default("all"),
    ...paginationQueryShape,
  })
  .strict()
  .meta({ id: "AdminUserListQuery" });

export const AdminUserListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rut: z.string(),
    // Null while the user is enabled.
    disabledAt: z.iso.datetime().nullable(),
    recentlyActive: z.boolean(),
  })
  .meta({ id: "AdminUserListItem" });

export const AdminUserListResponseSchema = z
  .object({
    users: z.array(AdminUserListItemSchema),
    ...paginationResponseShape,
  })
  .meta({ id: "AdminUserListResponse" });

export const AdminUserDetailSchema = AdminUserListItemSchema.extend({
  email: z.string().nullable(),
  mustChangePassword: z.boolean(),
  isPlatformAdministrator: z.boolean(),
}).meta({ id: "AdminUserDetail" });

export const AdminUserDetailGroupSchema = z
  .object({
    group: z.object({ id: z.string(), name: z.string() }),
    permissions: InvoicePermissionsSchema,
  })
  .meta({ id: "AdminUserDetailGroup" });

export const AdminUserDetailMembershipSchema = z
  .object({
    organization: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
    }),
    role: z.enum(OrganizationRole),
    permissions: InvoicePermissionsSchema,
    groups: z.array(AdminUserDetailGroupSchema),
  })
  .meta({ id: "AdminUserDetailMembership" });

export const AdminUserDetailResponseSchema = z
  .object({
    user: AdminUserDetailSchema,
    memberships: z.array(AdminUserDetailMembershipSchema),
  })
  .meta({ id: "AdminUserDetailResponse" });

export const AdminUserUpdateRequestSchema = z
  .object({ name: NameSchema.optional(), rut: RutInputSchema.optional() })
  .strict()
  .refine(
    (request) => request.name !== undefined || request.rut !== undefined,
    { message: "At least one of name or rut is required" },
  )
  .meta({
    id: "AdminUserUpdateRequest",
    description:
      "Changing the RUT revokes the user's sessions and API tokens; a change to the actor's own RUT is refused.",
  });

export const AdminUserUpdateResponseSchema = z
  .object({ user: AdminUserDetailSchema })
  .meta({ id: "AdminUserUpdateResponse" });

export const AdminUserPasswordResetRequestSchema = z
  .object({ temporaryPassword: DefinedTemporaryPasswordSchema.optional() })
  .strict()
  .meta({ id: "AdminUserPasswordResetRequest" });

export const AdminUserPasswordResetResponseSchema = z
  .object({
    temporaryPassword: TemporaryPasswordSchema.optional(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: "AdminUserPasswordResetResponse" });
