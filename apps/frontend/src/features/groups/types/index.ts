import type { Page } from "../../orgs/types";
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

/** One page of GET /organizations/{o}/groups/{g}/memberships. */
export interface GroupMemberPage extends Page {
  memberships: GroupMember[];
}

export interface CreateGroupInput {
  name: string;
  description?: string;
}
