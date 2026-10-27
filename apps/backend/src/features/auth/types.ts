import type { z } from "zod";

import type {
  AuthProfileSchema,
  LoginRequestSchema,
  PasswordChangeRequestSchema,
  ProfileUpdateSchema,
} from "./schemas.js";

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type AuthProfileDto = z.infer<typeof AuthProfileSchema>;
export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
