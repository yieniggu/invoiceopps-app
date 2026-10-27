import { z } from "zod";

import { UserSummarySchema } from "../orgs/schemas.js";

const flag = z.boolean();

export const GroupPermissionsSchema = z
  .object({
    readInvoices: flag,
    createInvoices: flag,
    deleteOwnInvoices: flag,
    deleteOthersInvoices: flag,
  })
  .strict()
  .meta({
    id: "GroupPermissions",
    description:
      "Four independent flags shared by every member of the group; none implies another.",
  });

export const GroupParamsSchema = z.object({
  organizationId: z.string(),
  groupId: z.string(),
});

export const GroupMembershipParamsSchema = GroupParamsSchema.extend({
  userId: z.string(),
});

export const GroupCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    // A blank description is stored as null, like an explicit null.
    description: z
      .string()
      .trim()
      .max(1_000)
      .transform((value) => value || null)
      .nullable()
      .optional(),
  })
  .strict()
  .meta({ id: "GroupCreateRequest" });

export const GroupPermissionsUpdateRequestSchema = z
  .object({ permissions: GroupPermissionsSchema })
  .strict()
  .meta({ id: "GroupPermissionsUpdateRequest" });

export const GroupMembershipCreateRequestSchema = z
  .object({ userId: z.string().trim().min(1) })
  .strict()
  .meta({ id: "GroupMembershipCreateRequest" });

export const GroupSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    permissions: GroupPermissionsSchema,
  })
  .meta({ id: "Group" });

export const GroupMembershipSchema = z
  .object({
    userId: z.string(),
    groupId: z.string(),
    organizationId: z.string(),
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

export const GroupMembershipListResponseSchema = z
  .object({ memberships: z.array(GroupMembershipWithUserSchema) })
  .meta({ id: "GroupMembershipListResponse" });

export const GroupMembershipResponseSchema = z
  .object({ membership: GroupMembershipSchema })
  .meta({ id: "GroupMembershipResponse" });
