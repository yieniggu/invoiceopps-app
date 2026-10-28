import { apiRequest } from "../../auth/api/apiRequest";
import type { InvoicePermissions } from "../types";

const org = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}`;

/** Replaces the four organization-level flags of one member atomically. */
export const putOrganizationPermissions = (
  organizationId: string,
  userId: string,
  permissions: InvoicePermissions,
) =>
  apiRequest<unknown>(
    `${org(organizationId)}/memberships/${encodeURIComponent(userId)}/permissions`,
    { method: "PUT", body: { permissions } },
  );

/** Replaces the four group-level flags of one member atomically. */
export const putGroupPermissions = (
  organizationId: string,
  groupId: string,
  userId: string,
  permissions: InvoicePermissions,
) =>
  apiRequest<unknown>(
    `${org(organizationId)}/groups/${encodeURIComponent(groupId)}/memberships/${encodeURIComponent(userId)}/permissions`,
    { method: "PUT", body: { permissions } },
  );

/** Replaces the organization-level flags of several members, all or nothing. */
export const putBulkOrganizationPermissions = (
  organizationId: string,
  userIds: string[],
  permissions: InvoicePermissions,
) =>
  apiRequest<unknown>(`${org(organizationId)}/memberships/permissions`, {
    method: "PUT",
    body: { userIds, permissions },
  });

/** Replaces the group-level flags of several members, all or nothing. */
export const putBulkGroupPermissions = (
  organizationId: string,
  groupId: string,
  userIds: string[],
  permissions: InvoicePermissions,
) =>
  apiRequest<unknown>(
    `${org(organizationId)}/groups/${encodeURIComponent(groupId)}/memberships/permissions`,
    { method: "PUT", body: { userIds, permissions } },
  );
