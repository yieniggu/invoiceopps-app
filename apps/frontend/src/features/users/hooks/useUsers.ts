import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupMembershipsKey,
  orgGroupsKey,
  orgKey,
  orgMembershipsKey,
  orgsKey,
  orgUsersKey,
  userBasicKey,
} from "../../auth/session/queryKeys";
import { getUserBasic } from "../../orgs/api/orgsApi";
import {
  createPlatformUser,
  listOrganizationUsersPage,
  provisionUser,
} from "../api/usersApi";
import type { PageRequest } from "../../orgs/types";
import type {
  CreateUserInput,
  IssuedCredential,
  ProvisionUserInput,
  UserGroupInput,
} from "../types";

/**
 * One page of the organization's people (administrators only), optionally
 * narrowed by a name or RUT fragment. Pages never walk the whole list: the
 * add-members picker asks for the page on screen.
 */
export function useOrgUsersPageQuery(
  organizationId: string,
  request: PageRequest & { search?: string },
) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: orgUsersKey(identityId, organizationId, request),
    queryFn: ({ signal }) =>
      listOrganizationUsersPage(organizationId, request, signal),
    // Paging and searching keep the rows on screen until the next ones arrive.
    placeholderData: keepPreviousData,
  });
}

/** Basic view of one person who shares an organization with me. */
export function useUserBasicQuery(userId: string, enabled = true) {
  const identityId = useIdentityId();
  return useQuery({
    queryKey: userBasicKey(identityId, userId),
    queryFn: ({ signal }) => getUserBasic(userId, signal),
    enabled,
  });
}

interface AffectedOrganization {
  organizationId: string;
  groups: UserGroupInput[];
}

/** A new person changes only the people lists of the organizations and groups
 * they were placed in; nothing else is refreshed. */
function invalidateAffected(
  client: QueryClient,
  identityId: string,
  affected: AffectedOrganization[],
): Promise<unknown> {
  // Awaited: the screens that follow show these lists right away.
  return Promise.all(
    affected.flatMap(({ organizationId, groups }) => [
      client.invalidateQueries({
        queryKey: orgMembershipsKey(identityId, organizationId),
      }),
      // The member count of the organization summary (exact: its key prefixes
      // every other key of the organization).
      client.invalidateQueries({
        queryKey: orgKey(identityId, organizationId),
        exact: true,
      }),
      client.invalidateQueries({
        queryKey: orgUsersKey(identityId, organizationId),
      }),
      ...groups.map(({ groupId }) =>
        client.invalidateQueries({
          queryKey: groupMembershipsKey(identityId, organizationId, groupId),
        }),
      ),
    ]),
  );
}

/** A 404 means a chosen organization or group vanished: refresh the choices. */
function refreshChoices(
  client: QueryClient,
  identityId: string,
  affected: AffectedOrganization[],
  error: unknown,
) {
  if (!isApiError(error) || error.status !== 404) return;
  void client.invalidateQueries({ queryKey: orgsKey(identityId) });
  for (const { organizationId } of affected)
    void client.invalidateQueries({
      queryKey: orgGroupsKey(identityId, organizationId),
    });
}

/**
 * `deliver` receives the one-time temporary password. It is not part of the
 * mutation variables or result, so it never enters the MutationCache. The
 * optional `readDefinedPassword` closure supplies an admin-defined password at
 * send time (from `useSecretOutbox`), for the same reason.
 */
export function useProvisionUser(
  organizationId: string,
  deliver: (credential: IssuedCredential) => void,
  readDefinedPassword?: () => string | undefined,
) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const affected = (input: ProvisionUserInput) => [
    { organizationId, groups: input.groups },
  ];
  return useMutation({
    mutationFn: (input: ProvisionUserInput) =>
      provisionUser(organizationId, input, deliver, readDefinedPassword?.()),
    onSuccess: (_result, input) =>
      invalidateAffected(client, identityId, affected(input)),
    onError: (error, input) =>
      refreshChoices(client, identityId, affected(input), error),
  });
}

/** Platform-wide creation; same secret transport as `useProvisionUser`. */
export function useCreatePlatformUser(
  deliver: (credential: IssuedCredential) => void,
  readDefinedPassword?: () => string | undefined,
) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      createPlatformUser(input, deliver, readDefinedPassword?.()),
    onSuccess: (_result, input) =>
      Promise.all([
        client.invalidateQueries({ queryKey: orgsKey(identityId) }),
        invalidateAffected(client, identityId, input.memberships),
      ]),
    onError: (error, input) =>
      refreshChoices(client, identityId, input.memberships, error),
  });
}
