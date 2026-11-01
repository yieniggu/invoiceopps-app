import type { Request, Response } from "express";

import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import { bearerUnauthenticated, type ApiTokenAuthenticator } from "./bearer.js";
import type { InvoiceActor } from "./types.js";

/** Where the Authorization guard of the app leaves a syntactically valid secret. */
export const BEARER_SECRET_LOCAL = "bearerSecret";

/**
 * The principal of an invoice operation: the Bearer token owner when the app
 * guard accepted an Authorization header, otherwise the session user. The
 * guard never lets both credentials through, so there is no fallback between
 * them. An unwired authenticator answers like a missing credential.
 */
export async function requireInvoiceActor(
  auth: AuthService | undefined,
  tokens: ApiTokenAuthenticator | undefined,
  request: Request,
  response: Response,
): Promise<InvoiceActor> {
  const secret: unknown = response.locals[BEARER_SECRET_LOCAL];
  if (typeof secret === "string") {
    if (!tokens) throw bearerUnauthenticated();
    return tokens.authenticate(secret);
  }
  const profile = await requireSessionProfile(auth, request, response);
  return { userId: profile.id, token: null };
}
