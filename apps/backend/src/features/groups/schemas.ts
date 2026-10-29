import { z } from "zod";

import {
  paginationQueryShape,
  paginationResponseShape,
} from "../../pagination.js";
import { MemberIdsSchema, UserSummarySchema } from "../orgs/schemas.js";
import { InvoicePermissionsSchema } from "./permissions-schema.js";
import { hasNoNul, NO_NUL } from "../../text.js";

export const GroupParamsSchema = z.object({
  organizationId: z.string(),
  groupId: z.string(),
});

export const GroupMembershipParamsSchema = GroupParamsSchema.extend({
  userId: z.string(),
});

export const GroupCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).refine(hasNoNul, NO_NUL),
    // A blank description is stored as null, like an explicit null.
    description: z
      .string()
      .trim()
      .max(1_000)
      .refine(hasNoNul, NO_NUL)
      .transform((value) => value || null)
      .nullable()
      .optional(),
  })
  .strict()
  .meta({ id: "GroupCreateRequest" });

export const GroupMembershipCreateRequestSchema = z
  .object({
    userId: z.uuid(),
    // Absent means every flag false.
    permissions: InvoicePermissionsSchema.optional(),
  })
  .strict()
  .meta({ id: "GroupMembershipCreateRequest" });

export const GroupMembershipBulkCreateRequestSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            userId: z.uuid(),
            // Absent means every flag false.
            permissions: InvoicePermissionsSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200)
      .refine(
        (members) =>
          new Set(members.map((member) => member.userId)).size ===
          members.length,
        { message: "userId values must be unique" },
      ),
  })
  .strict()
  .meta({ id: "GroupMembershipBulkCreateRequest" });

export const GroupSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  })
  .meta({ id: "Group" });

export const GroupMembershipSchema = z
  .object({
    userId: z.string(),
    groupId: z.string(),
    organizationId: z.string(),
    permissions: InvoicePermissionsSchema,
  })
  .meta({ id: "GroupMembership" });

export const GroupMembershipWithUserSchema = GroupMembershipSchema.extend({
  user: UserSummarySchema,
}).meta({ id: "GroupMembershipWithUser" });

export const GroupListResponseSchema = z
  .object({ groups: z.array(GroupSchema) })
  .meta({ id: "GroupListResponse" });

export const GroupResponseSchema = z
  .object({ group: GroupSchema })
  .meta({ id: "GroupResponse" });

export const GroupMembershipListQuerySchema = z
  .object({ userIds: MemberIdsSchema.optional(), ...paginationQueryShape })
  .strict()
  .meta({ id: "GroupMembershipListQuery" });

export const GroupMembershipListResponseSchema = z
  .object({
    memberships: z.array(GroupMembershipWithUserSchema),
    ...paginationResponseShape,
  })
  .meta({ id: "GroupMembershipListResponse" });

export const GroupMembershipResponseSchema = z
  .object({ membership: GroupMembershipSchema })
  .meta({ id: "GroupMembershipResponse" });

export const GroupMembershipsResponseSchema = z
  .object({ memberships: z.array(GroupMembershipSchema) })
  .meta({ id: "GroupMembershipsResponse" });
