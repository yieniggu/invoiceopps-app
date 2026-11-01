import { withQuery } from "../../../lib/pagination";
import { apiRequest } from "../../auth/api/apiRequest";
import type { ApiTokenInput, ApiTokenPage, IssuedApiToken } from "../types";

const base = "/api/v1/api-tokens";

export const listApiTokens = (
  request: { organizationId: string; page: number; pageSize: number },
  signal?: AbortSignal,
) => apiRequest<ApiTokenPage>(withQuery(base, request), { signal });

/**
 * Emits a token. The answer carries the only copy of the secret: callers hand
 * it straight to the one place that shows it and never keep it elsewhere.
 */
export async function createApiToken(
  input: ApiTokenInput,
  signal?: AbortSignal,
): Promise<IssuedApiToken> {
  const issued = await apiRequest<Partial<IssuedApiToken>>(base, {
    method: "POST",
    body: input,
    signal,
  });
  if (!issued.token || typeof issued.secret !== "string")
    throw new Error("Unexpected API token response");
  return { token: issued.token, secret: issued.secret };
}

/** The API answers 204 and repeats it for a token that is already revoked. */
export const revokeApiToken = (tokenId: string) =>
  apiRequest<void>(`${base}/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
