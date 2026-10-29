import type { z } from "zod";

import type {
  GroupCreateRequestSchema,
  GroupMembershipBulkCreateRequestSchema,
  GroupMembershipListResponseSchema,
  GroupMembershipSchema,
  GroupMembershipWithUserSchema,
  GroupSchema,
} from "./schemas.js";

export type GroupCreateRequest = z.infer<typeof GroupCreateRequestSchema>;
export type GroupMembershipBulkCreateRequest = z.infer<
  typeof GroupMembershipBulkCreateRequestSchema
>;
export type GroupDto = z.infer<typeof GroupSchema>;
export type GroupMembershipDto = z.infer<typeof GroupMembershipSchema>;
export type GroupMembershipListResponse = z.infer<
  typeof GroupMembershipListResponseSchema
>;
export type GroupMembershipWithUserDto = z.infer<
  typeof GroupMembershipWithUserSchema
>;

/**
 * Shape of the undocumented GET /groups kept for the policies screen: the
 * groups of the caller, never the people in them (member listings belong to
 * the organization ADMIN and the platform administrator).
 */
export interface GroupCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
}
