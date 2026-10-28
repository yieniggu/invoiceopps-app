import { useQueryClient } from "@tanstack/react-query";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsKey,
  orgMembershipsKey,
  orgUsersKey,
} from "../../auth/session/queryKeys";

/**
 * After a write fails because the people it targets changed meanwhile (404: a
 * person is gone; 409: already in the group or no longer in the organization),
 * refreshes every list the screens derive their people from, so the selection
 * is checked against the truth the same way the create-user wizard refreshes
 * its choices. Other failures leave the cache alone. The promise resolves once
 * the refetch is done. A write whose group is an input (not fixed by the
 * screen) passes it as the second argument.
 */
export function useConflictRefresh(organizationId: string, groupId?: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (
    error: unknown,
    affectedGroupId: string | undefined = groupId,
  ): Promise<unknown> => {
    if (!isApiError(error) || (error.status !== 404 && error.status !== 409))
      return Promise.resolve();
    return Promise.all([
      client.invalidateQueries({
        queryKey: orgMembershipsKey(identityId, organizationId),
      }),
      client.invalidateQueries({
        queryKey: orgUsersKey(identityId, organizationId),
      }),
      affectedGroupId === undefined
        ? undefined
        : client.invalidateQueries({
            queryKey: groupMembershipsKey(
              identityId,
              organizationId,
              affectedGroupId,
            ),
          }),
    ]);
  };
}
