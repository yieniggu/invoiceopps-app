import type { z } from "zod";

import type {
  OrganizationUserSchema,
  UserProvisionRequestSchema,
  UserProvisionResponseSchema,
} from "./schemas.js";

export type UserProvisionRequest = z.infer<typeof UserProvisionRequestSchema>;
export type OrganizationUserDto = z.infer<typeof OrganizationUserSchema>;
export type UserProvisionResponse = z.infer<typeof UserProvisionResponseSchema>;
