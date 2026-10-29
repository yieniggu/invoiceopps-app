import { MAX_BULK_MEMBERS } from "../../lib/limits";
import { isUuid } from "../../lib/uuid";

/** Every URL the app serves; screens link through these builders only. */
const segment = encodeURIComponent;

const organizationBase = (organizationId: string) =>
  `/organizations/${segment(organizationId)}`;
const groupBase = (organizationId: string, groupId: string) =>
  `${organizationBase(organizationId)}/groups/${segment(groupId)}`;

/** `?userIds=a,b`: the selection survives a reload because it is the URL. */
const userIdsQuery = (userIds: readonly string[]) =>
  `?userIds=${userIds.map(segment).join(",")}`;

/** Directory filters that live in the URL (`/admin?search=&status=&page=`). */
export interface AdminUsersParams {
  search?: string;
  status?: "all" | "active" | "disabled";
  page?: number;
}

/** Only non-default values are written, so `/admin` stays the clean URL. */
const listQuery = ({ search, status, page }: AdminUsersParams): string => {
  const query = new URLSearchParams();
  if (search) query.set("search", search);
  if (status && status !== "all") query.set("status", status);
  if (page && page > 1) query.set("page", String(page));
  const text = query.toString();
  return text ? `?${text}` : "";
};

export const paths = {
  dashboard: "/dashboard",
  invoices: "/invoices",
  policies: "/policies",
  profile: "/profile",
  changePassword: "/change-password",
  organizations: "/organizations",
  /** Platform directory of organizations; search and page travel in the URL. */
  organizationsPage: (params: { search?: string; page?: number } = {}) =>
    `/organizations${listQuery(params)}`,
  newOrganization: "/organizations/new",
  organization: organizationBase,
  editOrganization: (organizationId: string) =>
    `${organizationBase(organizationId)}/edit`,
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
  /** Platform directory of users; filters and page travel in the URL. */
  adminUsers: (params: AdminUsersParams = {}) => `/admin${listQuery(params)}`,
  adminUser: (userId: string) => `/admin/users/${segment(userId)}`,
  /** Basic profile of a person who shares an organization with me. */
  user: (userId: string) => `/users/${segment(userId)}`,
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
 * Reads the `userIds` query parameter: distinct UUIDs in order, at most
 * MAX_URL_USER_IDS of them (the rest is dropped). Anything that is not a UUID
 * is dropped too, so a crafted URL never reaches the API (which answers 400 to
 * it); the one id above the 200 limit only lets the screen say "too many".
 * Requests go out in chunks of at most 100, never as one list of 201.
 */
export function parseUserIds(search: URLSearchParams): string[] {
  const ids = new Set<string>();
  for (const id of (search.get("userIds") ?? "").split(",")) {
    if (!isUuid(id) || ids.has(id)) continue;
    ids.add(id);
    if (ids.size === MAX_URL_USER_IDS) break;
  }
  return [...ids];
}

/** One-shot message handed to the next screen through navigation state. */
export interface RouteNotice {
  notice?: string;
}
