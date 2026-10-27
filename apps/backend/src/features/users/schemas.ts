import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import {
  MembershipSchema,
  RutInputSchema,
  UserSummarySchema,
} from "../orgs/schemas.js";

export const UserProvisionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    rut: RutInputSchema,
    role: z.enum(OrganizationRole),
  })
  .strict()
  .meta({ id: "UserProvisionRequest" });

export const OrganizationUserSchema = UserSummarySchema.extend({
  role: z.enum(OrganizationRole),
}).meta({ id: "OrganizationUser" });

export const OrganizationUserListResponseSchema = z
  .object({ users: z.array(OrganizationUserSchema) })
  .meta({ id: "OrganizationUserListResponse" });

export const UserProvisionResponseSchema = z
  .object({
    user: UserSummarySchema.extend({ mustChangePassword: z.boolean() }),
    membership: MembershipSchema,
    temporaryPassword: z.string().meta({
      description:
        "Shown once; it is never stored in clear text and never logged.",
    }),
  })
  .meta({ id: "UserProvisionResponse" });
