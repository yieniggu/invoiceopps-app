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

export function useOrgMembersQuery(organizationId: string) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgMembershipsKey(identityId, organizationId),
    queryFn: ({ signal }) => listMemberships(organizationId, signal),
  });
}

/** Membership changes refresh this organization's people, never another's. */
function useInvalidateOrgPeople(organizationId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (affectedUserId?: string, { removed = false } = {}) => {
    void client.invalidateQueries({
      queryKey: orgMembershipsKey(identityId, organizationId),
    });
    void client.invalidateQueries({
      queryKey: orgUsersKey(identityId, organizationId),
    });
    if (removed) {
      // Removing a person also removes their group memberships here.
      void client.invalidateQueries({
        queryKey: orgGroupMembershipsPrefix(identityId, organizationId),
      });
    }
    if (affectedUserId === identityId) {
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
      void client.invalidateQueries({
        queryKey: workspaceGroupsKey(identityId),
      });
    }
  };
}

export function useAssignMember(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  return useMutation({
    mutationFn: (input: AssignMemberInput) =>
      assignMember(organizationId, input),
    onSuccess: ({ userId }) => invalidate(userId),
  });
}

export function useChangeRole(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  return useMutation({
    mutationFn: (input: { userId: string; role: OrganizationRole }) =>
      changeMemberRole(organizationId, input.userId, input.role),
    onSuccess: (_result, { userId }) => invalidate(userId),
  });
}

export function useRemoveMember(organizationId: string) {
  const invalidate = useInvalidateOrgPeople(organizationId);
  return useMutation({
    mutationFn: (input: { userId: string }) =>
      removeMember(organizationId, input.userId),
    onSuccess: (_result, { userId }) => invalidate(userId, { removed: true }),
  });
}

export { useInvalidateOrgPeople };
