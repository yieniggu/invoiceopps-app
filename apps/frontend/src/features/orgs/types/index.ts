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
  user: { id: string; name: string; rut: string };
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
