export type OrganizationRole = "ADMIN" | "USER";

export interface GroupCapabilities {
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}

export type Profile = {
  id: string;
  name: string;
  rut: string;
  email: string | null;
  username: string | null;
  isPlatformAdministrator: boolean;
  mustChangePassword?: boolean;
  memberships: Array<{
    organization: { id: string; name: string; slug: string };
    role: string;
  }>;
  contexts?: Array<{
    organizationId: string;
    organizationName: string;
    groupId: string;
    groupName: string;
    capabilities: GroupCapabilities;
  }>;
};
