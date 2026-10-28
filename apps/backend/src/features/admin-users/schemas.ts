import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import { InvoicePermissionsSchema } from "../groups/permissions-schema.js";
import { RutInputSchema } from "../orgs/schemas.js";
import {
  DefinedTemporaryPasswordSchema,
  GroupGrantResultSchema,
  GroupGrantSchema,
  MAX_GROUPS_PER_USER_CREATION,
  ProvisionedUserSchema,
  TemporaryPasswordSchema,
  uniqueGroupIds,
} from "../users/schemas.js";

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
    name: z.string().trim().min(1).max(120),
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
