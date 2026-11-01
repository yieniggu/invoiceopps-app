import type { z } from "zod";

import type {
  ApiTokenCreateRequestSchema,
  ApiTokenCreatedResponseSchema,
  ApiTokenListQuerySchema,
  ApiTokenPageSchema,
  ApiTokenSchema,
} from "./schemas.js";
import type { ApiScope } from "./scopes.js";

export type ApiTokenCreateRequest = z.infer<typeof ApiTokenCreateRequestSchema>;
export type ApiTokenListQuery = z.infer<typeof ApiTokenListQuerySchema>;
export type ApiTokenMetadata = z.infer<typeof ApiTokenSchema>;
export type ApiTokenCreatedResponse = z.infer<
  typeof ApiTokenCreatedResponseSchema
>;
export type ApiTokenPage = z.infer<typeof ApiTokenPageSchema>;

/** What a request authenticated with a Bearer token carries into a service. */
export interface ApiTokenContext {
  id: string;
  organizationId: string;
  groupId: string | null;
  scopes: ApiScope[];
}

/**
 * The authenticated principal of an invoice operation: the owner of the
 * session, or the owner of the Bearer token together with that token.
 */
export interface InvoiceActor {
  userId: string;
  token: ApiTokenContext | null;
}
