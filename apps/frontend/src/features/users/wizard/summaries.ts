import {
  countPermissions,
  type InvoicePermissions,
} from "../../permissions/types";

/** "sin permisos", "1 permiso", "2 permisos". */
export function permissionCountLabel(permissions: InvoicePermissions) {
  const count = countPermissions(permissions);
  if (count === 0) return "sin permisos";
  return count === 1 ? "1 permiso" : `${count} permisos`;
}

/** One-line recap of a folded organization card: "Test · Usuario · 2 permisos". */
export const organizationSummary = (
  organizationName: string | undefined,
  roleLabel: string,
  permissions: InvoicePermissions,
) =>
  [
    organizationName ?? "Sin organización seleccionada",
    roleLabel,
    permissionCountLabel(permissions),
  ].join(" · ");

/** One-line recap of a folded group card: "Ventas · 1 permiso". */
export const groupSummary = (
  groupName: string,
  permissions: InvoicePermissions,
) =>
  [
    groupName || "Sin grupo seleccionado",
    permissionCountLabel(permissions),
  ].join(" · ");

/** "sin grupos", "1 grupo", "3 grupos". */
export const groupCountLabel = (count: number) =>
  count === 0 ? "sin grupos" : count === 1 ? "1 grupo" : `${count} grupos`;
