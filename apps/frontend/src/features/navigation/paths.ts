import { MAX_BULK_MEMBERS } from "../../lib/limits";

/** Every URL the app serves; screens link through these builders only. */
const segment = encodeURIComponent;

const organizationBase = (organizationId: string) =>
  `/organizations/${segment(organizationId)}`;
const groupBase = (organizationId: string, groupId: string) =>
  `${organizationBase(organizationId)}/groups/${segment(groupId)}`;

/** `?userIds=a,b`: the selection survives a reload because it is the URL. */
const userIdsQuery = (userIds: readonly string[]) =>
  `?userIds=${userIds.map(segment).join(",")}`;

export const paths = {
  dashboard: "/dashboard",
  invoices: "/invoices",
  policies: "/policies",
  profile: "/profile",
  changePassword: "/change-password",
  organizations: "/organizations",
  newOrganization: "/organizations/new",
  organization: organizationBase,
  organizationMembers: (organizationId: string) =>
    `${organizationBase(organizationId)}/members`,
  newOrganizationMember: (organizationId: string) =>
    `${organizationBase(organizationId)}/members/new`,
  organizationMember: (organizationId: string, userId: string) =>
    `${organizationBase(organizationId)}/members/${segment(userId)}`,
  bulkOrganizationPermissions: (
    organizationId: string,
    userIds: readonly string[],
  ) =>
    `${organizationBase(organizationId)}/members/permissions${userIdsQuery(userIds)}`,
  organizationGroups: (organizationId: string) =>
    `${organizationBase(organizationId)}/groups`,
  newGroup: (organizationId: string) =>
    `${organizationBase(organizationId)}/groups/new`,
  group: groupBase,
  groupMembers: (organizationId: string, groupId: string) =>
    `${groupBase(organizationId, groupId)}/members`,
  newGroupMembers: (organizationId: string, groupId: string) =>
    `${groupBase(organizationId, groupId)}/members/new`,
  groupMember: (organizationId: string, groupId: string, userId: string) =>
    `${groupBase(organizationId, groupId)}/members/${segment(userId)}`,
  bulkGroupPermissions: (
    organizationId: string,
    groupId: string,
    userIds: readonly string[],
  ) =>
    `${groupBase(organizationId, groupId)}/members/permissions${userIdsQuery(userIds)}`,
  groups: "/groups",
  admin: "/admin",
  adminNewUser: "/admin/users/new",
  /** Platform wizard with an organization preselected. */
  adminNewUserIn: (organizationId: string) =>
    `/admin/users/new?organizationId=${segment(organizationId)}`,
} as const;

/**
 * One more than the bulk limit: a crafted URL never makes the app process an
 * unbounded list, and 201 ids still trip the "up to 200 people" guard.
 */
export const MAX_URL_USER_IDS = MAX_BULK_MEMBERS + 1;

/**
 * Reads the `userIds` query parameter: distinct, non-empty ids in order, at
 * most MAX_URL_USER_IDS of them (the rest is dropped).
 */
export function parseUserIds(search: URLSearchParams): string[] {
  const ids = new Set<string>();
  for (const id of (search.get("userIds") ?? "").split(",")) {
    if (id === "" || ids.has(id)) continue;
    ids.add(id);
    if (ids.size === MAX_URL_USER_IDS) break;
  }
  return [...ids];
}

/** One-shot message handed to the next screen through navigation state. */
export interface RouteNotice {
  notice?: string;
}
