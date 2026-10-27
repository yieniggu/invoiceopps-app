import type { z } from "zod";

import type {
  MembershipCreateRequestSchema,
  MembershipRoleRequestSchema,
  MembershipSchema,
  MembershipWithUserSchema,
  OrganizationCreateRequestSchema,
  OrganizationSchema,
} from "./schemas.js";

export type OrganizationCreateRequest = z.infer<
  typeof OrganizationCreateRequestSchema
>;
export type MembershipCreateRequest = z.infer<
  typeof MembershipCreateRequestSchema
>;
export type MembershipRoleRequest = z.infer<typeof MembershipRoleRequestSchema>;
export type OrganizationDto = z.infer<typeof OrganizationSchema>;
export type MembershipDto = z.infer<typeof MembershipSchema>;
export type MembershipWithUserDto = z.infer<typeof MembershipWithUserSchema>;
