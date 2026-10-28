import { useQueries } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import { orgGroupsKey } from "../../auth/session/queryKeys";
import { listGroups } from "../../groups/api/groupsApi";
import type { GroupOptions, UserDraft } from "./draft";

/**
 * The loaded groups of every organization in the draft, so a group chosen
 * earlier can be checked against what exists now. It shares the cache entry
 * of the groups step (same key), so it adds no request of its own; it only
 * fetches once the groups are relevant (`enabled`).
 */
export function useDraftGroupOptions(
  draft: UserDraft,
  enabled: boolean,
): GroupOptions {
  const identityId = useIdentityId();
  const ids = [
    ...new Set(
      draft.organizations
        .map(({ organizationId }) => organizationId)
        .filter((id) => id !== ""),
    ),
  ];
  const results = useQueries({
    queries: ids.map((organizationId) => ({
      queryKey: orgGroupsKey(identityId, organizationId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listGroups(organizationId, signal),
      enabled,
    })),
  });
  return new Map(
    ids.flatMap((id, index) => {
      const data = results[index]?.data;
      return data ? [[id, data] as const] : [];
    }),
  );
}
