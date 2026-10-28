import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  orgGroupMembershipsPrefix,
  orgMembershipsKey,
  orgUsersKey,
  profileKey,
  workspaceGroupsKey,
} from "../../auth/session/queryKeys";
import {
  assignMember,
  changeMemberRole,
  listMemberships,
  removeMember,
} from "../api/orgsApi";
import type { AssignMemberInput, OrganizationRole } from "../types";
import { useConflictRefresh } from "../../permissions/hooks/useConflictRefresh";
import { useInvalidateOrganizationSummary } from "./useOrganizations";

export function useOrgMembersQuery(organizationId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgMembershipsKey(identityId, organizationId),
    queryFn: ({ signal }) => listMemberships(organizationId, signal),
  });
}

/**
 * Membership changes refresh this organization's people, never another's. The
 * returned promise resolves once the lists on screen are fresh, so a flow that
 * navigates next (with a notice) lands on up-to-date data; the profile and the
 * workspace catalogue are conveniences and are not awaited.
 */
function useInvalidateOrgPeople(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const invalidateSummary = useInvalidateOrganizationSummary();
  return (
    affectedUserId?: string,
    { added = false, removed = false, deferSelf = false } = {},
  ): Promise<unknown> => {
    // `deferSelf`: the caller refreshes the profile itself once it has left
    // the screen (see `useRefreshIdentity`): a profile without this
    // organization would turn the screen into "not found" mid-removal.
    if (affectedUserId === identityId && !deferSelf) {
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
      void client.invalidateQueries({
        queryKey: workspaceGroupsKey(identityId),
      });
    }
    return Promise.all([
      client.invalidateQueries({
        queryKey: orgMembershipsKey(identityId, organizationId),
      }),
      // Only adding or removing a person moves the member count of the summary.
      added || removed ? invalidateSummary(organizationId) : undefined,
      client.invalidateQueries({
        queryKey: orgUsersKey(identityId, organizationId),
      }),
      // Removing a person also removes their group memberships here.
      removed
        ? client.invalidateQueries({
            queryKey: orgGroupMembershipsPrefix(identityId, organizationId),
          })
        : undefined,
    ]);
  };
}

/** Refreshes the profile and the workspace catalogue of the signed-in person. */
export function useRefreshIdentity() {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return () => {
    void client.invalidateQueries({ queryKey: profileKey(identityId) });
    void client.invalidateQueries({ queryKey: workspaceGroupsKey(identityId) });
  };
}

export function useAssignMember(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId);
  return useMutation({
    mutationFn: (input: AssignMemberInput) =>
      assignMember(organizationId, input),
    onSuccess: ({ userId }) => invalidate(userId, { added: true }),
    // 404/409: the person changed meanwhile; refresh what the screens show.
    onError: (error) => refreshAfterConflict(error),
  });
}

export function useChangeRole(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId);
  return useMutation({
    mutationFn: (input: { userId: string; role: OrganizationRole }) =>
      changeMemberRole(organizationId, input.userId, input.role),
    onSuccess: (_result, { userId }) => invalidate(userId),
    // 404/409: the person changed meanwhile; refresh what the screens show.
    onError: (error) => refreshAfterConflict(error),
  });
}

export function useRemoveMember(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId);
  return useMutation({
    mutationFn: (input: { userId: string }) =>
      removeMember(organizationId, input.userId),
    // Refreshing your own profile waits until the screen has navigated away.
    onSuccess: (_result, { userId }) =>
      invalidate(userId, { removed: true, deferSelf: true }),
    // 404/409: the person changed meanwhile; refresh what the screens show.
    onError: (error) => refreshAfterConflict(error),
  });
}

export { useInvalidateOrgPeople };
