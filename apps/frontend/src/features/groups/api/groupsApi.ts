import { apiRequest } from "../../auth/api/apiRequest";
import type {
  CreateGroupInput,
  Group,
  GroupMember,
  GroupPermissions,
} from "../types";

const base = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}/groups`;
const members = (organizationId: string, groupId: string) =>
  `${base(organizationId)}/${encodeURIComponent(groupId)}/memberships`;

export const listGroups = (organizationId: string, signal?: AbortSignal) =>
  apiRequest<{ groups: Group[] }>(base(organizationId), { signal }).then(
    (result) => result.groups,
  );

export const createGroup = (organizationId: string, input: CreateGroupInput) =>
  apiRequest<{ group: Group }>(base(organizationId), {
    method: "POST",
    body: input,
  });

/** Replaces the four flags atomically; the group name is never edited. */
export const updateGroupPermissions = (
  organizationId: string,
  groupId: string,
  permissions: GroupPermissions,
) =>
  apiRequest<{ group: Group }>(
    `${base(organizationId)}/${encodeURIComponent(groupId)}`,
    { method: "PATCH", body: { permissions } },
  );

export const listGroupMembers = (
  organizationId: string,
  groupId: string,
  signal?: AbortSignal,
) =>
  apiRequest<{ memberships: GroupMember[] }>(members(organizationId, groupId), {
    signal,
  }).then((result) => result.memberships);

export const addGroupMember = (
  organizationId: string,
  groupId: string,
  userId: string,
) =>
  apiRequest<unknown>(members(organizationId, groupId), {
    method: "POST",
    body: { userId },
  });

export const removeGroupMember = (
  organizationId: string,
  groupId: string,
  userId: string,
) =>
  apiRequest<void>(
    `${members(organizationId, groupId)}/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
