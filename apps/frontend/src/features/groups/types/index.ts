import type { GroupCapabilities } from "../../auth/types";

export type GroupPermissions = GroupCapabilities;

export const PERMISSION_LABELS: ReadonlyArray<
  readonly [keyof GroupPermissions, string]
> = [
  ["readInvoices", "Leer facturas"],
  ["createInvoices", "Crear facturas"],
  ["deleteOwnInvoices", "Eliminar facturas propias"],
  ["deleteOthersInvoices", "Eliminar facturas de otros"],
];

export interface Group {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  permissions: GroupPermissions;
}

export interface GroupMember {
  userId: string;
  groupId: string;
  organizationId: string;
  user: { id: string; name: string; rut: string };
}

export interface CreateGroupInput {
  name: string;
  description?: string;
}
