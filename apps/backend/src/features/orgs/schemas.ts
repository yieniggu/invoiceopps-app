import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import { parseRut } from "../../rut.js";
import { InvoicePermissionsSchema } from "../groups/permissions-schema.js";

const name = z.string().trim().min(1).max(120);
const role = z.enum(OrganizationRole);

/** Accepts any RUT spelling and yields the canonical storage form. */
export const RutInputSchema = z
  .string()
  .meta({ examples: ["12.345.678-5"] })
  .transform((value, context) => {
    try {
      return parseRut(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid RUT" });
      return z.NEVER;
    }
  });

export const OrganizationParamsSchema = z.object({
  organizationId: z.string(),
});

export const MembershipParamsSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});

export const OrganizationCreateRequestSchema = z
  .object({
    name,
    // The slug is validated as sent: it is never trimmed or normalized here.
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    // A blank description is stored as null, like an explicit null.
    description: z
      .string()
      .trim()
      .max(1_000)
      .transform((value) => value || null)
      .nullable()
      .optional(),
    firstAdminRut: RutInputSchema,
  })
  .strict()
  .meta({ id: "OrganizationCreateRequest" });

export const MembershipCreateRequestSchema = z
  .object({
    rut: RutInputSchema,
    role,
    // Absent means every flag false.
    permissions: InvoicePermissionsSchema.optional(),
  })
  .strict()
  .meta({ id: "MembershipCreateRequest" });

export const MembershipRoleRequestSchema = z
  .object({ role })
  .strict()
  .meta({ id: "MembershipRoleRequest" });

export const OrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: "Organization" });

export const MembershipSchema = z
  .object({
    userId: z.string(),
    organizationId: z.string(),
    role: z.enum(OrganizationRole),
    permissions: InvoicePermissionsSchema,
  })
  .meta({ id: "Membership" });

export const UserSummarySchema = z
  .object({ id: z.string(), name: z.string(), rut: z.string() })
  .meta({ id: "UserSummary" });

export const MembershipGroupSchema = z
  .object({
    groupId: z.string(),
    name: z.string(),
    permissions: InvoicePermissionsSchema,
  })
  .meta({ id: "MembershipGroup" });

export const MembershipWithUserSchema = MembershipSchema.extend({
  user: UserSummarySchema,
  groups: z.array(MembershipGroupSchema),
}).meta({ id: "MembershipWithUser" });

export const OrganizationListResponseSchema = z
  .object({ organizations: z.array(OrganizationSchema) })
  .meta({ id: "OrganizationListResponse" });

export const OrganizationCreateResponseSchema = z
  .object({ organization: OrganizationSchema, membership: MembershipSchema })
  .meta({ id: "OrganizationCreateResponse" });

export const MembershipListResponseSchema = z
  .object({ memberships: z.array(MembershipWithUserSchema) })
  .meta({ id: "MembershipListResponse" });

export const MembershipResponseSchema = z
  .object({ membership: MembershipSchema })
  .meta({ id: "MembershipResponse" });

export const OrganizationBasicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
  })
  .meta({ id: "OrganizationBasic" });

export const OrganizationCountsSchema = z
  .object({
    memberCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
  })
  .meta({
    id: "OrganizationCounts",
    description:
      "memberCount is every member; groupCount is every group for an ADMIN and the platform administrator, only own groups for a plain member",
  });

export const OrganizationDetailResponseSchema = z
  .object({
    organization: OrganizationBasicSchema,
    summary: OrganizationCountsSchema,
  })
  .meta({ id: "OrganizationDetailResponse" });

export const MembershipsResponseSchema = z
  .object({ memberships: z.array(MembershipSchema) })
  .meta({ id: "MembershipsResponse" });
