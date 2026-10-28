import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsKey,
  orgMembershipsKey,
  profileKey,
} from "../../auth/session/queryKeys";
import {
  putBulkGroupPermissions,
  putBulkOrganizationPermissions,
  putGroupPermissions,
  putOrganizationPermissions,
} from "../api/permissionsApi";
import type { InvoicePermissions } from "../types";
import { useConflictRefresh } from "./useConflictRefresh";

export type PermissionsTarget =
  | { level: "organization"; organizationId: string; userId: string }
  | {
      level: "group";
      organizationId: string;
      groupId: string;
      userId: string;
    };

/**
 * PUT of one member's four flags. Only what displays them is refreshed: the
 * profile, and the memberships list that carries them (the organization's for
 * organization level; the group's and the organization's for group level,
 * because the organization list shows each person's groups).
 */
export function useSavePermissions(target: PermissionsTarget) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const refreshAfterConflict = useConflictRefresh(
    target.organizationId,
    target.level === "group" ? target.groupId : undefined,
  );
  return useMutation({
    mutationFn: (permissions: InvoicePermissions) =>
      target.level === "organization"
        ? putOrganizationPermissions(
            target.organizationId,
            target.userId,
            permissions,
          )
        : putGroupPermissions(
            target.organizationId,
            target.groupId,
            target.userId,
            permissions,
          ),
    // Awaited, so the saved flags are fresh when the editor drops its draft.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: profileKey(identityId) }),
        client.invalidateQueries({
          queryKey: orgMembershipsKey(identityId, target.organizationId),
        }),
        target.level === "group"
          ? client.invalidateQueries({
              queryKey: groupMembershipsKey(
                identityId,
                target.organizationId,
                target.groupId,
              ),
            })
          : undefined,
      ]),
    // The member may be gone (404): refresh what the screen lists.
    onError: (error) => refreshAfterConflict(error),
  });
}

export type BulkPermissionsTarget =
  | { level: "organization"; organizationId: string }
  | { level: "group"; organizationId: string; groupId: string };

/**
 * Bulk PUT of the same four flags for several members, atomic on the server.
 * It refreshes the same lists as the single save, plus the profile (the actor
 * may be one of the members).
 */
export function useBulkSavePermissions(target: BulkPermissionsTarget) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const refreshAfterConflict = useConflictRefresh(
    target.organizationId,
    target.level === "group" ? target.groupId : undefined,
  );
  return useMutation({
    mutationFn: (input: {
      userIds: string[];
      permissions: InvoicePermissions;
    }) =>
      target.level === "organization"
        ? putBulkOrganizationPermissions(
            target.organizationId,
            input.userIds,
            input.permissions,
          )
        : putBulkGroupPermissions(
            target.organizationId,
            target.groupId,
            input.userIds,
            input.permissions,
          ),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: profileKey(identityId) }),
        client.invalidateQueries({
          queryKey: orgMembershipsKey(identityId, target.organizationId),
        }),
        target.level === "group"
          ? client.invalidateQueries({
              queryKey: groupMembershipsKey(
                identityId,
                target.organizationId,
                target.groupId,
              ),
            })
          : undefined,
      ]),
    // A listed person who left meanwhile fails the whole batch (404): refresh
    // the lists so the screen shows who is still there.
    onError: (error) => refreshAfterConflict(error),
  });
}

/** The bulk save mutation, as the shared bulk screen consumes it. */
export type BulkSavePermissions = ReturnType<typeof useBulkSavePermissions>;
