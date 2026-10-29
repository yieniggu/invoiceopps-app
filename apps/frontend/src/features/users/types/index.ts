import type { OrganizationRole } from "../../auth/types";
import type { Page } from "../../orgs/types";
import type { InvoicePermissions } from "../../permissions/types";

export interface OrganizationUser {
  id: string;
  name: string;
  rut: string;
  role: OrganizationRole;
}

/** One page of the people of an organization (GET /organizations/{o}/users). */
export interface OrganizationUserPage extends Page {
  users: OrganizationUser[];
}

/** A group a new user joins, with the flags they get in it. */
export interface UserGroupInput {
  groupId: string;
  permissions: InvoicePermissions;
}

/** Organization-scoped provisioning (POST /organizations/{o}/users). */
export interface ProvisionUserInput {
  name: string;
  rut: string;
  role: OrganizationRole;
  permissions: InvoicePermissions;
  groups: UserGroupInput[];
}

/** One organization of a platform-created user. */
export interface UserMembershipInput {
  organizationId: string;
  role: OrganizationRole;
  permissions: InvoicePermissions;
  groups: UserGroupInput[];
}

/** Platform provisioning (POST /admin/users): 0..50 organizations. */
export interface CreateUserInput {
  name: string;
  rut: string;
  memberships: UserMembershipInput[];
}

/** What the server shows once; it only ever travels to the dialog callback. */
export interface IssuedCredential {
  userId: string;
  name: string;
  temporaryPassword: string;
}

/** The only thing a provisioning mutation resolves with. */
export interface ProvisionedUser {
  userId: string;
  name: string;
}
