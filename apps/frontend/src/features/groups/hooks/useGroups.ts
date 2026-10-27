import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsKey,
  orgGroupsKey,
  profileKey,
  workspaceGroupsKey,
} from "../../auth/session/queryKeys";
import { runGroupSetup, type GroupSetup } from "../api/groupSetup";
import {
  addGroupMember,
  createGroup,
  listGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroupPermissions,
} from "../api/groupsApi";
import type { CreateGroupInput, GroupPermissions } from "../types";

export function useGroupsQuery(organizationId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgGroupsKey(identityId, organizationId),
    queryFn: ({ signal }) => listGroups(organizationId, signal),
  });
}

export function useGroupMembersQuery(organizationId: string, groupId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: groupMembershipsKey(identityId, organizationId, groupId),
    queryFn: ({ signal }) => listGroupMembers(organizationId, groupId, signal),
  });
}

export interface CreateGroupPlan {
  group: CreateGroupInput;
  setup: GroupSetup;
}

/**
 * Creates the group, then applies its permissions and memberships one step
 * at a time. Only the group POST can fail the mutation; later steps report
 * what failed in `failed`, because the group already exists by then.
 */
export function useCreateGroupFlow(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useMutation({
    mutationFn: async ({ group, setup }: CreateGroupPlan) => {
      const { group: created } = await createGroup(organizationId, group);
      const failed = await runGroupSetup(organizationId, created.id, setup);
      return { groupId: created.id, failed };
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: orgGroupsKey(identityId, organizationId),
      });
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
      void client.invalidateQueries({
        queryKey: workspaceGroupsKey(identityId),
      });
    },
  });
}

/** Retries only the steps of a group's initial setup that failed. */
export function useRetryGroupSetup(organizationId: string, groupId: string) {
  const invalidate = useInvalidateGroup(organizationId, groupId);
  return useMutation({
    mutationFn: (setup: GroupSetup) =>
      runGroupSetup(organizationId, groupId, setup),
    onSettled: () => invalidate(),
  });
}

/** Permission and membership changes refresh only this organization's groups,
 * this group's memberships and the profile; other groups stay untouched. */
function useInvalidateGroup(organizationId: string, groupId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (affectedUserId?: string) => {
    // The group list is awaited: screens read permissions from it.
    const groups = client.invalidateQueries({
      queryKey: orgGroupsKey(identityId, organizationId),
    });
    void client.invalidateQueries({
      queryKey: groupMembershipsKey(identityId, organizationId, groupId),
    });
    void client.invalidateQueries({ queryKey: profileKey(identityId) });
    if (affectedUserId === identityId)
      void client.invalidateQueries({
        queryKey: workspaceGroupsKey(identityId),
      });
    return groups;
  };
}

export function useUpdatePermissions(organizationId: string, groupId: string) {
  const invalidate = useInvalidateGroup(organizationId, groupId);
  return useMutation({
    mutationFn: (permissions: GroupPermissions) =>
      updateGroupPermissions(organizationId, groupId, permissions),
    onSuccess: () => invalidate(),
  });
}

export function useAddGroupMember(organizationId: string, groupId: string) {
  const invalidate = useInvalidateGroup(organizationId, groupId);
  return useMutation({
    mutationFn: (input: { userId: string }) =>
      addGroupMember(organizationId, groupId, input.userId),
    onSuccess: (_result, { userId }) => invalidate(userId),
  });
}

export function useRemoveGroupMember(organizationId: string, groupId: string) {
  const invalidate = useInvalidateGroup(organizationId, groupId);
  return useMutation({
    mutationFn: (input: { userId: string }) =>
      removeGroupMember(organizationId, groupId, input.userId),
    onSuccess: (_result, { userId }) => invalidate(userId),
  });
}
