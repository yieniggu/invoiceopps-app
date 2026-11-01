import { useQuery } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { apiTokensKey } from "../../auth/session/queryKeys";
import { listApiTokens } from "../api/apiTokensApi";

const organizationOf = (queryKey: readonly unknown[] | undefined) =>
  (queryKey?.at(-1) as { organizationId?: string } | undefined)?.organizationId;

/**
 * One page of the person's own tokens in one organization. Moving between
 * pages of the SAME organization keeps the previous page on screen (flagged
 * `isPlaceholderData`); another organization never inherits it.
 */
export function useApiTokensQuery(request: {
  organizationId: string;
  page: number;
  pageSize: number;
}) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: apiTokensKey(identityId, request),
    queryFn: ({ signal }) => listApiTokens(request, signal),
    placeholderData: (previous, previousQuery) =>
      organizationOf(previousQuery?.queryKey) === request.organizationId
        ? previous
        : undefined,
  });
}
