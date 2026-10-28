import { z } from "zod";

import { OrganizationRole } from "../../generated/prisma/client.js";
import { InvoicePermissionsSchema } from "../groups/permissions-schema.js";
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
        permissions: InvoicePermissionsSchema.meta({
          description: "Flags of the organization membership alone.",
        }),
        groups: z.array(
          z.object({
            group: z.object({ id: z.string(), name: z.string() }),
            permissions: InvoicePermissionsSchema.meta({
              description: "Flags of the group membership alone.",
            }),
            effective: InvoicePermissionsSchema.meta({
              description:
                "Organization flags OR group flags (all false while the organization is disabled or onboarding is pending). Presentation only: the server decides.",
            }),
          }),
        ),
      }),
    ),
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
            permissions: {
              readInvoices: true,
              createInvoices: false,
              deleteOwnInvoices: false,
              deleteOthersInvoices: false,
            },
            groups: [
              {
                group: { id: "group-1", name: "Finance" },
                permissions: {
                  readInvoices: false,
                  createInvoices: true,
                  deleteOwnInvoices: false,
                  deleteOthersInvoices: false,
                },
                effective: {
                  readInvoices: true,
                  createInvoices: true,
                  deleteOwnInvoices: false,
                  deleteOthersInvoices: false,
                },
              },
            ],
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
  })
  .meta({ id: "ProfileUpdateRequest" });
