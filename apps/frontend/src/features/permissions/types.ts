/**
 * The independent flags a person holds at one level: four invoice flags and
 * `deployModels` (MLOPS-05, deploy registered models). None implies another.
 */
export interface InvoicePermissions {
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
  deployModels: boolean;
}

/** The four invoice flags: what the "n de 4" summary and "Marcar todos" cover. */
export const PERMISSION_LABELS: ReadonlyArray<
  readonly [keyof InvoicePermissions, string]
> = [
  ["readInvoices", "Leer facturas"],
  ["createInvoices", "Crear facturas"],
  ["deleteOwnInvoices", "Eliminar facturas propias"],
  ["deleteOthersInvoices", "Eliminar facturas de otros"],
];

/** The model flag: shown as its own toggle, outside the invoice summary. */
export const MODEL_PERMISSION_LABEL: readonly [
  keyof InvoicePermissions,
  string,
] = ["deployModels", "Desplegar modelos"];

/**
 * What a bulk PUT carries: the four invoice flags always, and `deployModels`
 * only when the admin touched that toggle (the backend keeps each member's own
 * value when it is omitted, CR-590).
 */
export type BulkPermissions = Omit<InvoicePermissions, "deployModels"> &
  Partial<Pick<InvoicePermissions, "deployModels">>;

export const NO_PERMISSIONS: InvoicePermissions = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
  deployModels: false,
};

/**
 * Sets the four invoice flags together and leaves `deployModels` as it is:
 * deploying models is a separate decision, never implied nor undone by the
 * «Marcar todos» / «Desmarcar todos» buttons.
 */
export const withInvoiceFlags = (
  permissions: InvoicePermissions,
  on: boolean,
): InvoicePermissions => ({
  ...permissions,
  readInvoices: on,
  createInvoices: on,
  deleteOwnInvoices: on,
  deleteOthersInvoices: on,
});

/** Number of flags set to true. */
export const countPermissions = (permissions: InvoicePermissions) =>
  PERMISSION_LABELS.filter(([flag]) => permissions[flag]).length;

/** "2 de 4": the compact permission summary of tables and folded editors. */
export const permissionRatio = (permissions: InvoicePermissions) =>
  `${countPermissions(permissions)} de ${PERMISSION_LABELS.length}`;

export const samePermissions = (
  left: InvoicePermissions,
  right: InvoicePermissions,
) =>
  [...PERMISSION_LABELS, MODEL_PERMISSION_LABEL].every(
    ([flag]) => left[flag] === right[flag],
  );

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
