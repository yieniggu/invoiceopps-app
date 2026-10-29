import type { z } from "zod";

import type {
  OrganizationUserListResponseSchema,
  OrganizationUserSchema,
  UserBasicResponseSchema,
  UserProvisionRequestSchema,
  UserProvisionResponseSchema,
} from "./schemas.js";

export type OrganizationUserListResponse = z.infer<
  typeof OrganizationUserListResponseSchema
>;
export type UserProvisionRequest = z.infer<typeof UserProvisionRequestSchema>;
export type OrganizationUserDto = z.infer<typeof OrganizationUserSchema>;
export type UserProvisionResponse = z.infer<typeof UserProvisionResponseSchema>;
export type UserBasicResponse = z.infer<typeof UserBasicResponseSchema>;
