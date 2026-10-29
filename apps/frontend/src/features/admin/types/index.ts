import type { Page, PageRequest } from "../../orgs/types";
import type { InvoicePermissions } from "../../permissions/types";

export type AdminUserStatus = "all" | "active" | "disabled";

/** What the directory sends: filters plus the page. */
export interface AdminUsersRequest extends PageRequest {
  search: string;
  status: AdminUserStatus;
}

export interface AdminUserListItem {
  id: string;
  name: string;
  /** Canonical (no dash); format it with fromApiRut. */
  rut: string;
  /** ISO date when the account was disabled, null while enabled. */
  disabledAt: string | null;
  recentlyActive: boolean;
}

export interface AdminUserPage extends Page {
  users: AdminUserListItem[];
}

export interface AdminUser {
  id: string;
  name: string;
  rut: string;
  email: string | null;
  disabledAt: string | null;
  mustChangePassword: boolean;
  recentlyActive: boolean;
  isPlatformAdministrator: boolean;
}

export interface AdminUserMembership {
  organization: { id: string; name: string; slug: string };
  role: string;
  permissions: InvoicePermissions;
  groups: Array<{
    group: { id: string; name: string };
    permissions: InvoicePermissions;
  }>;
}

export interface AdminUserDetail {
  user: AdminUser;
  memberships: AdminUserMembership[];
}

export interface UpdateAdminUserInput {
  name?: string;
  rut?: string;
}

/** The temporary password never appears here: it only reaches the dialog. */
export interface PasswordResetResult {
  expiresAt: string;
}
