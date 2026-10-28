import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsKey,
  orgGroupsKey,
  orgMembershipsKey,
  profileKey,
  workspaceGroupsKey,
} from "../../auth/session/queryKeys";
import { useInvalidateOrganizationSummary } from "../../orgs/hooks/useOrganizations";
import {
  addGroupMember,
  addGroupMembers,
  createGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
} from "../api/groupsApi";
import { useConflictRefresh } from "../../permissions/hooks/useConflictRefresh";
import type { InvoicePermissions } from "../../permissions/types";
import type { CreateGroupInput } from "../types";

export function useGroupsQuery(organizationId: string, enabled = true) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgGroupsKey(identityId, organizationId),
    queryFn: ({ signal }) => listGroups(organizationId, signal),
    enabled,
  });
}

export function useGroupMembersQuery(
  organizationId: string,
  groupId: string,
  enabled = true,
) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: groupMembershipsKey(identityId, organizationId, groupId),
    queryFn: ({ signal }) => listGroupMembers(organizationId, groupId, signal),
    enabled,
  });
}

/**
 * Creating a group refreshes the group lists and the summary group count. The
 * list is awaited: the screen that follows looks the new group up in it.
 */
export function useCreateGroup(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const invalidateSummary = useInvalidateOrganizationSummary();
  return useMutation({
    mutationFn: (group: CreateGroupInput) => createGroup(organizationId, group),
    onSuccess: async () => {
      invalidateSummary(organizationId);
      await client.invalidateQueries({
        queryKey: orgGroupsKey(identityId, organizationId),
      });
    },
  });
}

/**
 * Membership changes refresh this organization's groups, the memberships of
 * the group and this organization's memberships (they list each person's
 * groups); other groups stay untouched. The returned promise resolves once
 * those lists are fresh, so a flow that navigates next lands on current data;
 * the profile and the workspace catalogue are not awaited.
 */
function useInvalidateGroup(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (
    groupId: string,
    affectedUserIds: readonly string[],
  ): Promise<unknown> => {
    void client.invalidateQueries({ queryKey: profileKey(identityId) });
    if (affectedUserIds.includes(identityId))
      void client.invalidateQueries({
        queryKey: workspaceGroupsKey(identityId),
      });
    return Promise.all([
      client.invalidateQueries({
        queryKey: orgGroupsKey(identityId, organizationId),
      }),
      client.invalidateQueries({
        queryKey: groupMembershipsKey(identityId, organizationId, groupId),
      }),
      client.invalidateQueries({
        queryKey: orgMembershipsKey(identityId, organizationId),
      }),
    ]);
  };
}

/** Adds one person to any group of the organization (the group is an input). */
export function useAddGroupMember(organizationId: string) {
  const invalidate = useInvalidateGroup(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId);
  return useMutation({
    mutationFn: (input: {
      groupId: string;
      userId: string;
      permissions: InvoicePermissions;
    }) =>
      addGroupMember(
        organizationId,
        input.groupId,
        input.userId,
        input.permissions,
      ),
    onSuccess: (_result, { groupId, userId }) => invalidate(groupId, [userId]),
    // The person or the group may be gone, or the person already inside.
    onError: (error, { groupId }) => refreshAfterConflict(error, groupId),
  });
}

/** Atomic bulk add: every person with their own flags, or nobody. */
export function useAddGroupMembers(organizationId: string, groupId: string) {
  const invalidate = useInvalidateGroup(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId, groupId);
  return useMutation({
    mutationFn: (
      members: Array<{ userId: string; permissions: InvoicePermissions }>,
    ) => addGroupMembers(organizationId, groupId, members),
    onSuccess: (_result, members) =>
      invalidate(
        groupId,
        members.map(({ userId }) => userId),
      ),
    // A person who left the organization or joined the group meanwhile makes
    // the whole batch fail: refresh the people the form offers.
    onError: (error) => refreshAfterConflict(error),
  });
}

export function useRemoveGroupMember(organizationId: string) {
  const invalidate = useInvalidateGroup(organizationId);
  const refreshAfterConflict = useConflictRefresh(organizationId);
  return useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      removeGroupMember(organizationId, input.groupId, input.userId),
    onSuccess: (_result, { groupId, userId }) => invalidate(groupId, [userId]),
    onError: (error, { groupId }) => refreshAfterConflict(error, groupId),
  });
}
