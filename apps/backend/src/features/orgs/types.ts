import type { z } from "zod";

import type {
  MembershipCreateRequestSchema,
  MembershipRoleRequestSchema,
  MembershipSchema,
  MembershipWithUserSchema,
  OrganizationCountsSchema,
  OrganizationCreateRequestSchema,
  OrganizationBasicSchema,
  OrganizationListQuerySchema,
  OrganizationListResponseSchema,
  OrganizationMemberListResponseSchema,
  MembershipListResponseSchema,
  OrganizationSchema,
  OrganizationUpdateRequestSchema,
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
export type OrganizationBasicDto = z.infer<typeof OrganizationBasicSchema>;
export type OrganizationCountsDto = z.infer<typeof OrganizationCountsSchema>;
export type OrganizationUpdateRequest = z.infer<
  typeof OrganizationUpdateRequestSchema
>;
export type OrganizationListQuery = z.infer<typeof OrganizationListQuerySchema>;
export type OrganizationListResponse = z.infer<
  typeof OrganizationListResponseSchema
>;
export type MembershipListResponse = z.infer<
  typeof MembershipListResponseSchema
>;
export type OrganizationMemberListResponse = z.infer<
  typeof OrganizationMemberListResponseSchema
>;
