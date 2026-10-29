import type { z } from "zod";

import type {
  AdminUserCreateRequestSchema,
  AdminUserDeactivationResponseSchema,
  AdminUserCreateResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserListQuerySchema,
  AdminUserListResponseSchema,
  AdminUserPasswordResetRequestSchema,
  AdminUserPasswordResetResponseSchema,
  AdminUserUpdateRequestSchema,
  AdminUserUpdateResponseSchema,
} from "./schemas.js";

export type AdminUserCreateRequest = z.infer<
  typeof AdminUserCreateRequestSchema
>;
export type AdminUserCreateResponse = z.infer<
  typeof AdminUserCreateResponseSchema
>;
export type AdminUserDeactivationResponse = z.infer<
  typeof AdminUserDeactivationResponseSchema
>;
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;
export type AdminUserDetailResponse = z.infer<
  typeof AdminUserDetailResponseSchema
>;
export type AdminUserUpdateRequest = z.infer<
  typeof AdminUserUpdateRequestSchema
>;
export type AdminUserUpdateResponse = z.infer<
  typeof AdminUserUpdateResponseSchema
>;
export type AdminUserPasswordResetRequest = z.infer<
  typeof AdminUserPasswordResetRequestSchema
>;
export type AdminUserPasswordResetResponse = z.infer<
  typeof AdminUserPasswordResetResponseSchema
>;
