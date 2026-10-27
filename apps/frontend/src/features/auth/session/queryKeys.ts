// Query keys per RP0 README: everything remote hangs under the identity so a
// partition never shares entries with another person.

export const sessionProfileKey = ["session", "profile"] as const;

const identity = (identityId: string) => ["identity", identityId] as const;

export const profileKey = (identityId: string) =>
  [...identity(identityId), "profile"] as const;

export const orgsKey = (identityId: string) =>
  [...identity(identityId), "orgs"] as const;

const orgScope = (identityId: string, organizationId: string) =>
  [...identity(identityId), "org", organizationId] as const;

export const orgMembershipsKey = (identityId: string, organizationId: string) =>
  [...orgScope(identityId, organizationId), "memberships"] as const;

export const orgUsersKey = (identityId: string, organizationId: string) =>
  [...orgScope(identityId, organizationId), "users"] as const;

export const orgGroupsKey = (identityId: string, organizationId: string) =>
  [...orgScope(identityId, organizationId), "groups"] as const;

/** Every group-membership query of one organization (prefix match). */
export const orgGroupMembershipsPrefix = (
  identityId: string,
  organizationId: string,
) => [...orgScope(identityId, organizationId), "group"] as const;

export const groupMembershipsKey = (
  identityId: string,
  organizationId: string,
  groupId: string,
) =>
  [
    ...orgScope(identityId, organizationId),
    "group",
    groupId,
    "memberships",
  ] as const;

/** Legacy group catalogue feeding the invoice and policy workspace. */
export const workspaceGroupsKey = (identityId: string) =>
  [...identity(identityId), "workspace", "groups"] as const;
