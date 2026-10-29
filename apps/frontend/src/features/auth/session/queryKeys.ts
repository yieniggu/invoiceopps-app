// Query keys per RP0 README: everything remote hangs under the identity so a
// partition never shares entries with another person.

export const sessionProfileKey = ["session", "profile"] as const;

const identity = (identityId: string) => ["identity", identityId] as const;

export const profileKey = (identityId: string) =>
  [...identity(identityId), "profile"] as const;

/** Page of a paginated list; part of the key so every page caches apart. */
export interface PageParams {
  page: number;
  pageSize: number;
}

/** Organization list: without params it is the prefix of every page. */
export const orgsKey = (
  identityId: string,
  params?: PageParams & { search?: string },
) =>
  params === undefined
    ? ([...identity(identityId), "orgs"] as const)
    : ([...identity(identityId), "orgs", params] as const);

/** Directory of users (platform administrator): prefix without params. */
export const adminUsersKey = (identityId: string, params?: object) =>
  params === undefined
    ? ([...identity(identityId), "admin", "users"] as const)
    : ([...identity(identityId), "admin", "users", params] as const);

/** One user as the platform administrator sees them (profile + memberships). */
export const adminUserKey = (identityId: string, userId: string) =>
  [...identity(identityId), "admin", "user", userId] as const;

/** Basic view of one user (name, email, shared organizations). */
export const userBasicKey = (identityId: string, userId: string) =>
  [...identity(identityId), "user", userId, "basic"] as const;

const orgScope = (identityId: string, organizationId: string) =>
  [...identity(identityId), "org", organizationId] as const;

/**
 * Summary of one organization. This key is a prefix of every other key of the
 * organization, so it is only ever invalidated with `exact: true`.
 */
export const orgKey = (identityId: string, organizationId: string) =>
  orgScope(identityId, organizationId);

/** Memberships of an organization: without params the prefix of every page. */
export const orgMembershipsKey = (
  identityId: string,
  organizationId: string,
  params?: PageParams,
) =>
  params === undefined
    ? ([...orgScope(identityId, organizationId), "memberships"] as const)
    : ([
        ...orgScope(identityId, organizationId),
        "memberships",
        params,
      ] as const);

/**
 * Memberships of the given people, looked up by id (the member screen, the
 * bulk editor). It lives under the memberships prefix, so every membership
 * change refreshes it.
 */
export const orgMembershipsByIdsKey = (
  identityId: string,
  organizationId: string,
  userIds: readonly string[],
) =>
  [
    ...orgScope(identityId, organizationId),
    "memberships",
    "ids",
    userIds,
  ] as const;

/** Reduced member list (any member may read it); same prefix rule. */
export const orgMembersKey = (
  identityId: string,
  organizationId: string,
  params?: PageParams,
) =>
  params === undefined
    ? ([...orgScope(identityId, organizationId), "members"] as const)
    : ([...orgScope(identityId, organizationId), "members", params] as const);

/** People of an organization: without params the prefix of every page. */
export const orgUsersKey = (
  identityId: string,
  organizationId: string,
  params?: PageParams & { search?: string },
) =>
  params === undefined
    ? ([...orgScope(identityId, organizationId), "users"] as const)
    : ([...orgScope(identityId, organizationId), "users", params] as const);

export const orgGroupsKey = (identityId: string, organizationId: string) =>
  [...orgScope(identityId, organizationId), "groups"] as const;

/** Every group-membership query of one organization (prefix match). */
export const orgGroupMembershipsPrefix = (
  identityId: string,
  organizationId: string,
) => [...orgScope(identityId, organizationId), "group"] as const;

/**
 * Memberships of one group: without params the prefix of every page and every
 * lookup by ids (so a membership change refreshes them all).
 */
export const groupMembershipsKey = (
  identityId: string,
  organizationId: string,
  groupId: string,
  params?: PageParams,
) =>
  params === undefined
    ? ([
        ...orgScope(identityId, organizationId),
        "group",
        groupId,
        "memberships",
      ] as const)
    : ([
        ...orgScope(identityId, organizationId),
        "group",
        groupId,
        "memberships",
        params,
      ] as const);

/** Memberships of the given people of one group, looked up by id. */
export const groupMembershipsByIdsKey = (
  identityId: string,
  organizationId: string,
  groupId: string,
  userIds: readonly string[],
) =>
  [
    ...groupMembershipsKey(identityId, organizationId, groupId),
    "ids",
    userIds,
  ] as const;

/** Legacy group catalogue feeding the invoice and policy workspace. */
export const workspaceGroupsKey = (identityId: string) =>
  [...identity(identityId), "workspace", "groups"] as const;
