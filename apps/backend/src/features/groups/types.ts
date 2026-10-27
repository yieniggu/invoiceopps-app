import type { z } from "zod";

import type {
  GroupCreateRequestSchema,
  GroupMembershipCreateRequestSchema,
  GroupMembershipSchema,
  GroupMembershipWithUserSchema,
  GroupPermissionsSchema,
  GroupPermissionsUpdateRequestSchema,
  GroupSchema,
} from "./schemas.js";

export type GroupCreateRequest = z.infer<typeof GroupCreateRequestSchema>;
export type GroupPermissions = z.infer<typeof GroupPermissionsSchema>;
export type GroupPermissionsUpdateRequest = z.infer<
  typeof GroupPermissionsUpdateRequestSchema
>;
export type GroupMembershipCreateRequest = z.infer<
  typeof GroupMembershipCreateRequestSchema
>;
export type GroupDto = z.infer<typeof GroupSchema>;
export type GroupMembershipDto = z.infer<typeof GroupMembershipSchema>;
export type GroupMembershipWithUserDto = z.infer<
  typeof GroupMembershipWithUserSchema
>;

/** Shape of the undocumented GET /groups kept for the policies screen. */
export interface GroupWithMembersResponse {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
  members: Array<{ id: string; name: string; rut: string }>;
}
