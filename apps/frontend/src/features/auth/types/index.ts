import type { InvoicePermissions } from "../../permissions/types";

export type OrganizationRole = "ADMIN" | "USER";

export type GroupMembershipProfile = {
  group: { id: string; name: string };
  /** Flags granted directly at the group level. */
  permissions: InvoicePermissions;
  /** What the person can actually do through this group (presentation only). */
  effective: InvoicePermissions;
};

export type Profile = {
  id: string;
  name: string;
  rut: string;
  email: string | null;
  username: string | null;
  isPlatformAdministrator: boolean;
  mustChangePassword?: boolean;
  memberships: Array<{
    organization: {
      id: string;
      name: string;
      slug: string;
      /** Whether the Models section is on for the organization (MLOPS-05). */
      mlEnabled: boolean;
    };
    role: string;
    permissions: InvoicePermissions;
    groups: GroupMembershipProfile[];
  }>;
};
