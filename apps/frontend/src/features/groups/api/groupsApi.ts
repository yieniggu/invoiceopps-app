import { apiRequest } from "../../auth/api/apiRequest";
import type { InvoicePermissions } from "../../permissions/types";
import type { CreateGroupInput, Group, GroupMember } from "../types";

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
  permissions: InvoicePermissions,
) =>
  apiRequest<unknown>(members(organizationId, groupId), {
    method: "POST",
    body: { userId, permissions },
  });

/** Adds several organization members at once, each with its own flags. */
export const addGroupMembers = (
  organizationId: string,
  groupId: string,
  memberships: Array<{ userId: string; permissions: InvoicePermissions }>,
) =>
  apiRequest<{ memberships: unknown[] }>(
    `${members(organizationId, groupId)}/bulk`,
    { method: "POST", body: { members: memberships } },
  );

export const removeGroupMember = (
  organizationId: string,
  groupId: string,
  userId: string,
) =>
  apiRequest<void>(
    `${members(organizationId, groupId)}/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
