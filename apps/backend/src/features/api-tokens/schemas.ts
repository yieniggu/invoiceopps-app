import { z } from "zod";

import {
  paginationQueryShape,
  paginationResponseShape,
} from "../../pagination.js";
import { NameSchema } from "../orgs/schemas.js";
import { validateTokenExpiry } from "./authorization.js";
import { API_SCOPES } from "./scopes.js";

const scope = z.enum(API_SCOPES);

const EXAMPLE_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

export const ApiTokenCreateRequestSchema = z
  .object({
    name: NameSchema,
    organizationId: z.uuid(),
    groupId: z.uuid().optional().meta({
      description:
        "Restricts the token to one group; omit it for an organization token",
    }),
    scopes: z
      .array(scope)
      .min(1)
      .max(API_SCOPES.length)
      .refine((scopes) => new Set(scopes).size === scopes.length, {
        message: "Scopes must be unique",
      }),
    expiresAt: z.iso
      .datetime({ offset: true })
      .refine((value) => validateTokenExpiry(new Date(value), new Date()), {
        message: "expiresAt must be in the future and at most 30 days ahead",
      }),
  })
  .strict()
  .meta({
    id: "ApiTokenCreateRequest",
    description:
      "Operational API token emission body. The secret and its hash are server-generated.",
    // A getter: the example is recomputed each time the OpenAPI document is
    // built, so its expiresAt (now + 7 days) never goes stale.
    get examples() {
      return [
        {
          name: "ci pipeline",
          organizationId: "11111111-1111-4111-8111-111111111111",
          groupId: "22222222-2222-4222-8222-222222222222",
          scopes: ["invoices:read", "invoices:create"],
          expiresAt: new Date(Date.now() + EXAMPLE_VALIDITY_MS).toISOString(),
        },
      ];
    },
  });

/** Explicit metadata DTO: never the hash or the secret. */
export const ApiTokenSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    organizationId: z.uuid(),
    groupId: z.uuid().nullable(),
    scopes: z.array(scope),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .meta({
    id: "ApiToken",
    description: "Metadata of an operational API token.",
  });

export const ApiTokenCreatedResponseSchema = z
  .object({
    token: ApiTokenSchema,
    secret: z.string().meta({
      description:
        "The bearer secret (iop_ prefix). Returned only by this response; store it now.",
    }),
  })
  .meta({
    id: "ApiTokenCreatedResponse",
    description: "A newly emitted token with its one-time secret.",
  });

export const ApiTokenListQuerySchema = z
  .object({
    organizationId: z.uuid(),
    groupId: z.uuid().optional(),
    ...paginationQueryShape,
  })
  .strict()
  .meta({ id: "ApiTokenListQuery" });

export const ApiTokenPageSchema = z
  .object({ items: z.array(ApiTokenSchema), ...paginationResponseShape })
  .meta({
    id: "ApiTokenPage",
    description:
      "One page of the caller's own tokens, revoked ones included, newest first.",
  });

export const ApiTokenParamsSchema = z.object({ tokenId: z.uuid() });
