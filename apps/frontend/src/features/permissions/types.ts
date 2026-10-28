/** The four independent invoice flags a person holds at one level. */
export interface InvoicePermissions {
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}

export const PERMISSION_LABELS: ReadonlyArray<
  readonly [keyof InvoicePermissions, string]
> = [
  ["readInvoices", "Leer facturas"],
  ["createInvoices", "Crear facturas"],
  ["deleteOwnInvoices", "Eliminar facturas propias"],
  ["deleteOthersInvoices", "Eliminar facturas de otros"],
];

export const NO_PERMISSIONS: InvoicePermissions = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

export const ALL_PERMISSIONS: InvoicePermissions = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};

/** Number of flags set to true. */
export const countPermissions = (permissions: InvoicePermissions) =>
  PERMISSION_LABELS.filter(([flag]) => permissions[flag]).length;

/** "2 de 4": the compact permission summary of tables and folded editors. */
export const permissionRatio = (permissions: InvoicePermissions) =>
  `${countPermissions(permissions)} de ${PERMISSION_LABELS.length}`;

export const samePermissions = (
  left: InvoicePermissions,
  right: InvoicePermissions,
) => PERMISSION_LABELS.every(([flag]) => left[flag] === right[flag]);

const joinWithY = (parts: string[]) =>
  parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
    : (parts[0] ?? "");

/** Human summary of the four independent invoice flags. */
export function describePermissions(permissions: InvoicePermissions) {
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
