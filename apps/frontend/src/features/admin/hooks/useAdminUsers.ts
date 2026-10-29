import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  adminUserKey,
  adminUsersKey,
  orgGroupMembershipsPrefix,
  orgMembershipsKey,
  orgMembersKey,
  orgUsersKey,
  profileKey,
  userBasicKey,
} from "../../auth/session/queryKeys";
import type { IssuedCredential } from "../../users/types";
import {
  getAdminUser,
  listAdminUsers,
  resetAdminUserPassword,
  setAdminUserDeactivation,
  updateAdminUser,
} from "../api/adminUsersApi";
import type {
  AdminUserDetail,
  AdminUsersRequest,
  UpdateAdminUserInput,
} from "../types";

export function useAdminUsersQuery(request: AdminUsersRequest) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: adminUsersKey(identityId, request),
    queryFn: ({ signal }) => listAdminUsers(request, signal),
    // Paging keeps the rows on screen until the next page arrives.
    placeholderData: keepPreviousData,
  });
}

export function useAdminUserQuery(userId: string, enabled = true) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: adminUserKey(identityId, userId),
    queryFn: ({ signal }) => getAdminUser(userId, signal),
    enabled,
  });
}

/**
 * A change to a person refreshes their detail, every page of the directory,
 * their basic profile and, for each organization they belong to, its people
 * lists (members, users, group memberships: names, RUT and the enabled flag
 * show in all of them). When the edited person is the signed-in
 * one, their own profile (name, RUT in the header and the shell) is refreshed
 * as well. The organizations come from the detail already cached; the promise
 * resolves once what is on screen is fresh.
 */
function useInvalidateAdminUser(userId: string) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return (): Promise<unknown> => {
    const detail = client.getQueryData<AdminUserDetail>(
      adminUserKey(identityId, userId),
    );
    // Not awaited: the profile feeds the shell, not the screen being edited.
    if (userId === identityId)
      void client.invalidateQueries({ queryKey: profileKey(identityId) });
    return Promise.all([
      client.invalidateQueries({ queryKey: adminUserKey(identityId, userId) }),
      client.invalidateQueries({ queryKey: adminUsersKey(identityId) }),
      client.invalidateQueries({ queryKey: userBasicKey(identityId, userId) }),
      ...(detail?.memberships ?? []).flatMap(({ organization }) => [
        client.invalidateQueries({
          queryKey: orgMembershipsKey(identityId, organization.id),
        }),
        client.invalidateQueries({
          queryKey: orgMembersKey(identityId, organization.id),
        }),
        client.invalidateQueries({
          queryKey: orgUsersKey(identityId, organization.id),
        }),
        // Every group read of the organization (pages and lookups by id).
        client.invalidateQueries({
          queryKey: orgGroupMembershipsPrefix(identityId, organization.id),
        }),
      ]),
    ]);
  };
}

export function useUpdateAdminUser(userId: string) {
  const invalidate = useInvalidateAdminUser(userId);
  return useMutation({
    mutationFn: (input: UpdateAdminUserInput) => updateAdminUser(userId, input),
    onSuccess: invalidate,
  });
}

/**
 * `deliver` receives the one-time temporary password; it is not a variable or
 * a result, and the mutation is flagged `sensitive` so the MutationCache
 * forgets it the moment it settles.
 */
export function useResetAdminUserPassword(
  user: { id: string; name: string },
  deliver: (credential: IssuedCredential) => void,
) {
  const invalidate = useInvalidateAdminUser(user.id);
  return useMutation({
    mutationFn: () => resetAdminUserPassword(user, deliver),
    meta: { sensitive: true },
    // The user must now change the password: the detail says so. The refresh
    // is not awaited, so the mutation settles (and the reset button is
    // enabled again) as soon as the password was issued; otherwise closing
    // the dialog before the refetch ends would find the trigger disabled and
    // focus would fall back to the page title.
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useSetAdminUserDeactivation(userId: string) {
  const invalidate = useInvalidateAdminUser(userId);
  return useMutation({
    mutationFn: (disabled: boolean) =>
      setAdminUserDeactivation(userId, disabled),
    onSuccess: invalidate,
  });
}
