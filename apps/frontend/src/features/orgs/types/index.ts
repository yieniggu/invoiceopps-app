export type { OrganizationRole } from "../../auth/types";
import type { OrganizationRole } from "../../auth/types";

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
}
