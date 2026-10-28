import type { z } from "zod";

import type {
  AdminUserCreateRequestSchema,
  AdminUserCreateResponseSchema,
} from "./schemas.js";

export type AdminUserCreateRequest = z.infer<
  typeof AdminUserCreateRequestSchema
>;
export type AdminUserCreateResponse = z.infer<
  typeof AdminUserCreateResponseSchema
>;
