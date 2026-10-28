import type { InvoicePermissions } from "../../permissions/types";

export interface Group {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
}

export interface GroupMember {
  userId: string;
  groupId: string;
  organizationId: string;
  permissions: InvoicePermissions;
  user: { id: string; name: string; rut: string };
}

export interface CreateGroupInput {
  name: string;
  description?: string;
}
