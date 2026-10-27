import type { GroupPermissions } from "./index";

const joinWithY = (parts: string[]) =>
  parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
    : (parts[0] ?? "");

/** Human summary of the four independent invoice flags. */
export function describePermissions(permissions: GroupPermissions) {
  const clauses: string[] = [];
  const base = [
    permissions.readInvoices ? "leer" : "",
    permissions.createInvoices ? "crear" : "",
  ].filter(Boolean);
  if (base.length > 0) clauses.push(`${joinWithY(base)} facturas`);
  if (permissions.deleteOwnInvoices && permissions.deleteOthersInvoices)
    clauses.push("eliminar facturas propias y de otras personas");
  else if (permissions.deleteOwnInvoices)
    clauses.push("eliminar sus propias facturas");
  else if (permissions.deleteOthersInvoices)
    clauses.push("eliminar facturas de otras personas");
  return clauses.length === 0
    ? "Sin permisos sobre facturas"
    : `Puede ${joinWithY(clauses)}`;
}

export const NO_PERMISSIONS: GroupPermissions = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

export const hasAnyPermission = (permissions: GroupPermissions) =>
  Object.values(permissions).some(Boolean);
