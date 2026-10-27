import { useState } from "react";

import { useUpdatePermissions } from "./useGroups";
import type { Group, GroupPermissions } from "../types";

/**
 * Permission edits of the group detail. The draft only holds what the person
 * changed; until then the saved flags come straight from the group query.
 */
export function useGroupPermissionsDraft(organizationId: string, group: Group) {
  const update = useUpdatePermissions(organizationId, group.id);
  const [draft, setDraft] = useState<GroupPermissions>();
  const permissions = draft ?? group.permissions;

  const save = () => {
    if (update.isPending) return;
    // All four flags are sent so the replacement is atomic.
    update.mutate(
      { ...permissions },
      // The group list is refetched before this runs, so the saved flags show.
      { onSuccess: () => setDraft(undefined) },
    );
  };
  return { update, permissions, setDraft, save };
}
