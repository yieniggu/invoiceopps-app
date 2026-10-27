import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy.js";

export const LoginRequestSchema = z
  .object({
    rut: z.string().meta({ examples: ["12.345.678-5"] }),
    password: z.string().max(MAX_PASSWORD_LENGTH),
  })
  .meta({ id: "LoginRequest" });

export const AuthUserSchema = z
  .object({ id: z.string(), name: z.string(), rut: z.string() })
  .meta({ id: "AuthUser" });

export const LoginResponseSchema = z
  .object({ user: AuthUserSchema })
  .meta({ id: "LoginResponse" });

export const AuthProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    rut: z.string(),
    email: z.string().nullable(),
    username: z.string().nullable(),
    mustChangePassword: z.boolean(),
    isPlatformAdministrator: z.boolean(),
    memberships: z.array(
      z.object({
        organization: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
        }),
        role: z.enum(OrganizationRole),
      }),
    ),
    contexts: z
      .array(
        z.object({
          organizationId: z.string(),
          organizationName: z.string(),
          groupId: z.string(),
          groupName: z.string(),
          capabilities: z.object({
            readInvoices: z.boolean(),
            createInvoices: z.boolean(),
            deleteOwnInvoices: z.boolean(),
            deleteOthersInvoices: z.boolean(),
          }),
        }),
      )
      .meta({
        description:
          "Groups of enabled organizations where the user has both memberships; capabilities are the group flags.",
      }),
  })
  .meta({
    id: "AuthProfile",
    examples: [
      {
        id: "user-1",
        name: "Ada Lovelace",
        rut: "12.345.678-5",
        email: null,
        username: "ada",
        mustChangePassword: false,
        isPlatformAdministrator: false,
        memberships: [
          {
            organization: { id: "org-1", name: "Acme", slug: "acme" },
            role: "USER",
          },
        ],
        contexts: [
          {
            organizationId: "org-1",
            organizationName: "Acme",
            groupId: "group-1",
            groupName: "Finance",
            capabilities: {
              readInvoices: true,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
          },
        ],
      },
    ],
  });

export const ProfileResponseSchema = z
  .object({ profile: AuthProfileSchema })
  .meta({ id: "ProfileResponse" });

export const PasswordChangeRequestSchema = z
  .object({
    currentPassword: z.string().max(MAX_PASSWORD_LENGTH),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, {
        error: `The new password must have at least ${MIN_PASSWORD_LENGTH} characters`,
      })
      .max(MAX_PASSWORD_LENGTH, {
        error: `The new password cannot exceed ${MAX_PASSWORD_LENGTH} characters`,
      }),
  })
  .strict()
  .meta({ id: "PasswordChangeRequest" });

// Legacy PATCH /profile body (RP0-05 owns its final shape); not documented yet.
export const ProfileUpdateSchema = z
  .object({
    email: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
  })
  .strict()
  .refine((update) => Object.keys(update).length > 0, {
    message: "At least one field is required",
    // Unknown keys already produced an issue; do not add a second one.
    when: (payload) => payload.issues.length === 0,
  });
