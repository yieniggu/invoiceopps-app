import { useQuery } from "@tanstack/react-query";

import { readApiError } from "../auth/api/apiError";
import { protectedFetch } from "../auth/api/protectedFetch";
import { workspaceGroupsKey } from "../auth/session/queryKeys";
import type { Profile } from "../auth/types";

export type WorkspaceGroup = {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
};

/** Where the group catalogue that feeds the workspace stands. */
export type ContextState = "idle" | "loading" | "error" | "loaded";

async function requestWorkspaceGroups(): Promise<WorkspaceGroup[]> {
  // The invoice and policy screens keep their existing group catalogue.
  const response = await protectedFetch("/api/v1/groups", {
    credentials: "same-origin",
  });
  if (!response.ok) throw await readApiError(response);
  return ((await response.json()) as { groups: WorkspaceGroup[] }).groups;
}

/**
 * Group catalogue behind the workspace contexts (invoices and policies).
 * A person without memberships has nothing to load: the empty catalogue is
 * confirmed immediately instead of being requested.
 */
export function useWorkspaceGroups(profile: Profile) {
  const hasMemberships = profile.memberships.length > 0;
  const query = useQuery({
    queryKey: workspaceGroupsKey(profile.id),
    queryFn: requestWorkspaceGroups,
    enabled: hasMemberships,
    staleTime: Infinity,
  });
  // A revalidation in flight suspends the confirmed catalogue (loading), and a
  // failed one blocks it (error) until a retry succeeds; stale data is never
  // presented as confirmed.
  const state: ContextState = !hasMemberships
    ? "loaded"
    : query.isFetching
      ? "loading"
      : query.isError
        ? "error"
        : query.data
          ? "loaded"
          : "loading";
  return {
    state,
    groups: hasMemberships ? query.data : [],
    // A failed read is retried explicitly, never silently.
    retry: () => void query.refetch(),
  };
}
