import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { normalizeIds } from "../../../lib/pagination";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsByIdsKey,
  groupMembershipsKey,
  orgGroupsKey,
  orgMembershipsKey,
  profileKey,
  workspaceGroupsKey,
} from "../../auth/session/queryKeys";
import { listMembershipsByIds } from "../../orgs/api/orgsApi";
import { useInvalidateOrganizationSummary } from "../../orgs/hooks/useOrganizations";
import {
  addGroupMember,
  addGroupMembers,
  createGroup,
  listGroupMembers,
  listGroupMembersByIds,
  listGroups,
  removeGroupMember,
} from "../api/groupsApi";
import { useConflictRefresh } from "../../permissions/hooks/useConflictRefresh";
import type { InvoicePermissions } from "../../permissions/types";
import type { PageRequest } from "../../orgs/types";
import type { CreateGroupInput } from "../types";

export function useGroupsQuery(organizationId: string, enabled = true) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgGroupsKey(identityId, organizationId),
    queryFn: ({ signal }) => listGroups(organizationId, signal),
    enabled,
  });
}

/**
 * One page of the group's people (administrators only). The paginated table
 * and the member count read this; a person looked up by id uses
 * `useGroupMembersByIdsQuery`.
 */
export function useGroupMembersPageQuery(
  organizationId: string,
  groupId: string,
  request: PageRequest,
  enabled = true,
) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: groupMembershipsKey(identityId, organizationId, groupId, request),
    queryFn: ({ signal }) =>
      listGroupMembers(organizationId, groupId, request, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The memberships of exactly the given people, wherever they sit in the
 * group's list: one member's screen, the bulk editor, and the "who is already
 * in the group" check of the add form.
 */
export function useGroupMembersByIdsQuery(
  organizationId: string,
  groupId: string,
  userIds: readonly string[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const identityId = useIdentityId();
  // Sorted and de-duplicated once per array: a stable key, shared by equal sets.
  const ids = useMemo(() => normalizeIds(userIds), [userIds]);
  return useQuery({
    queryKey: groupMembershipsByIdsKey(
      identityId,
      organizationId,
      groupId,
      ids,
    ),
    queryFn: ({ signal }) =>
      listGroupMembersByIds(organizationId, groupId, ids, signal),
    enabled,
  });
}

/**
 * After a batch was refused because the people it targets changed, tells which
 * of them can no longer be added: gone from the organization, or already in the
 * group. Both are read by id (chunked, at most four requests at a time), never
 * by walking a list, and only when a conflict happened.
 */
export function useUnavailableMembers(organizationId: string, groupId: string) {
  return async (
    userIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<Set<string>> => {
    const [organization, group] = await Promise.all([
      listMembershipsByIds(organizationId, userIds, signal),
      listGroupMembersByIds(organizationId, groupId, userIds, signal),
    ]);
    const inOrganization = new Set(organization.map(({ userId }) => userId));
    const inGroup = new Set(group.map(({ userId }) => userId));
    return new Set(
      userIds.filter((id) => !inOrganization.has(id) || inGroup.has(id)),
    );
  };
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
