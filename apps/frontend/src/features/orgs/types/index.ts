export type { OrganizationRole } from "../../auth/types";
import type { OrganizationRole } from "../../auth/types";
import type { InvoicePermissions } from "../../permissions/types";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface OrganizationMember {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  /** Organization-level flags, straight from the server. */
  permissions: InvoicePermissions;
  /** Groups of this organization the person belongs to, with their flags there. */
  groups: Array<{
    groupId: string;
    name: string;
    permissions: InvoicePermissions;
  }>;
  /** The RUT is canonical (no dash); format it with fromApiRut to display. */
  user: {
    id: string;
    name: string;
    rut: string;
    disabled: boolean;
    recentlyActive: boolean;
  };
}

/** Paging of every paginated list: the request and the echoed envelope. */
export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface Page extends PageRequest {
  total: number;
}

export interface OrganizationPage extends Page {
  organizations: Organization[];
}

export interface MembershipPage extends Page {
  memberships: OrganizationMember[];
}

/** Reduced member of the organization (what any member may see). */
export interface OrganizationMemberBasic {
  userId: string;
  name: string;
  email: string | null;
  recentlyActive: boolean;
}

export interface MemberBasicPage extends Page {
  members: OrganizationMemberBasic[];
}

export interface OrganizationBasic {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

/** The slug is immutable; a null or blank description clears it. */
export interface UpdateOrganizationInput {
  name?: string;
  description?: string | null;
}

export interface UserBasic {
  user: {
    id: string;
    name: string;
    email: string | null;
    recentlyActive: boolean;
  };
  sharedOrganizations: Array<{ id: string; name: string }>;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  description?: string;
  firstAdminRut: string;
}

export interface AssignMemberInput {
  rut: string;
  role: OrganizationRole;
  permissions?: InvoicePermissions;
}

/** Counts of the organization summary (groups: those the person can see). */
export interface OrganizationSummary {
  organization: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  };
  summary: { memberCount: number; groupCount: number };
}
