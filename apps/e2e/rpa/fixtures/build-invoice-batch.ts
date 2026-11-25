import { resolve } from "node:path";

import ExcelJS from "exceljs";

import { INPUT_COLUMNS } from "../excel.ts";

/**
 * Writes `invoice-batch.xlsx`, the reference input of the invoice bot.
 *
 * Placeholders are replaced in a run-specific copy (see `fillPlaceholders`):
 * `{{ORG}}`, `{{GROUP}}`, `{{UNKNOWN_GROUP}}` and `{{RUN}}` (prefix that keeps
 * business ids unique per run). `expected` is `RESULT` or `RESULT:detail`
 * (field name or error code) and `fault` names the failure the TEST HARNESS
 * injects for that row; the bot reads neither.
 */

type Cell = string | number | Date | null;
export interface FixtureRow {
  id: string;
  group?: string;
  businessId: string | null;
  supplier?: string | null;
  amount?: Cell;
  issued?: Cell;
  due?: Cell;
  status?: string;
  expected: string;
  fault?: string;
  note: string;
}

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ISSUED = day("2026-10-25");
const DUE = "2026-11-25";

const invoiceBatchRows: FixtureRow[] = [
  {
    id: "r01",
    businessId: "{{RUN}}-001",
    supplier: "Proveedor Uno",
    amount: 12500,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED",
    note: "Organization scope, Excel date and numeric amount",
  },
  {
    id: "r02",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-002",
    supplier: "Proveedor Dos",
    amount: 480000,
    issued: "2026-10-26",
    due: day("2026-11-26"),
    status: "PENDING",
    expected: "CREATED",
    note: "Group scope, text issued date",
  },
  {
    id: "r03",
    businessId: "{{RUN}}-003",
    supplier: "Proveedor Tres",
    amount: "12.500",
    issued: ISSUED,
    due: DUE,
    status: "APPROVED",
    expected: "CREATED",
    note: "Status APPROVED, amount typed with a thousands separator",
  },
  {
    id: "r04",
    businessId: "{{RUN}}-004",
    supplier: null,
    amount: 9900,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:supplierName",
    note: "Empty supplier",
  },
  {
    id: "r05",
    businessId: "{{RUN}}-005",
    supplier: "Proveedor Cinco",
    amount: "12500,5",
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:amount",
    note: "Decimal amount",
  },
  {
    id: "r06",
    businessId: "{{RUN}}-006",
    supplier: "Proveedor Seis",
    amount: 15000,
    issued: ISSUED,
    due: "2026-10-01",
    status: "PENDING",
    expected: "REJECTED_FIELD:dueOn",
    note: "Due before issued",
  },
  {
    id: "r07",
    businessId: null,
    supplier: "Proveedor Siete",
    amount: 15000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:businessId",
    note: "Empty business id",
  },
  {
    id: "r08",
    businessId: "{{RUN}}-001",
    supplier: "Proveedor Ocho",
    amount: 7000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED:BUSINESS_ID_CONFLICT",
    note: "Same business id as r01",
  },
  {
    id: "r09",
    group: "{{UNKNOWN_GROUP}}",
    businessId: "{{RUN}}-009",
    supplier: "Proveedor Nueve",
    amount: 7000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "ERROR:GROUP_NOT_FOUND",
    note: "Group the account is not offered",
  },
  {
    id: "r10",
    businessId: "{{RUN}}-010",
    supplier: "Proveedor Diez",
    amount: 21000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED_AFTER_RETRY",
    fault: "503-once",
    note: "First POST answers 503",
  },
  {
    id: "r11",
    businessId: "{{RUN}}-011",
    supplier: "Proveedor Once",
    amount: 22000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED_AFTER_RETRY",
    fault: "network-once",
    note: "First POST gets no response",
  },
  {
    id: "r12",
    businessId: "{{RUN}}-012",
    supplier: "Proveedor Doce",
    amount: 23000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "UNCERTAIN",
    fault: "503-always",
    note: "Every POST answers 503; nothing is created",
  },
  {
    id: "r13",
    businessId: "{{RUN}}-013",
    supplier: "Proveedor Trece",
    amount: 24000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED_RECONCILED",
    fault: "lost-response-always",
    note: "The server creates it, every response is lost",
  },
  {
    id: "r14",
    businessId: "{{RUN}}-014",
    supplier: "Proveedor Catorce",
    amount: 25000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "MANUAL_REVIEW",
    fault: "idempotency-409",
    note: "IDEMPOTENCY_CONFLICT: the bot must never confirm a new operation",
  },
  {
    id: "r15",
    businessId: "{{RUN}}-015",
    supplier: "Proveedor Quince",
    amount: 26000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED:FORBIDDEN",
    fault: "forbidden-403",
    note: "POST answers 403",
  },
  {
    id: "r16",
    businessId: "{{RUN}}-016",
    supplier: "Proveedor Dieciséis",
    amount: 27000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED",
    fault: "session-expired",
    note: "Session ends right before the submit: re-login, check, resend",
  },
];

/**
 * Classroom demo: valid and invalid cases only. No `fault` rows (the demo has
 * no fault injection, so every row must end in its `expected` on its own).
 * Rows target `{{GROUP}}`, except d12 (a group the account does not have) and
 * d13 (blank group: organization-level creation, only valid for an account
 * with organization-level create). The class robot requires `in_GroupName`, so
 * the same file also drives the UiPath lab with d13 as an extra case.
 * Supplier names are made up.
 */
const demoRows: FixtureRow[] = [
  {
    id: "d01",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-001",
    supplier: "Ferretería Aurora Demo",
    amount: 185000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED",
    note: "Estado PENDING",
  },
  {
    id: "d02",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-002",
    supplier: "Papelería Brisa Demo",
    amount: 64900,
    issued: ISSUED,
    due: DUE,
    status: "APPROVED",
    expected: "CREATED",
    note: "Estado APPROVED",
  },
  {
    id: "d03",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-003",
    supplier: "Transportes Cóndor Demo",
    amount: "320.000",
    issued: ISSUED,
    due: DUE,
    status: "APPROVED",
    expected: "CREATED",
    note: "Monto con separador de miles",
  },
  {
    id: "d04",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-004",
    supplier: "Servicios Delta Demo",
    amount: 45000,
    issued: ISSUED,
    due: DUE,
    status: "REJECTED",
    expected: "CREATED",
    note: "Estado REJECTED",
  },
  {
    id: "d05",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-005",
    supplier: "Insumos Estrella Demo",
    amount: 99000,
    issued: ISSUED,
    due: DUE,
    status: "CANCELLED",
    expected: "CREATED",
    note: "Estado CANCELLED",
  },
  {
    id: "d06",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-006",
    supplier: null,
    amount: 28000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:supplierName",
    note: "Proveedor vacío",
  },
  {
    id: "d07",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-007",
    supplier: "Logística Faro Demo",
    amount: "12500,5",
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:amount",
    note: "Monto mal formado (decimal)",
  },
  {
    id: "d08",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-008",
    supplier: "Mantención Glaciar Demo",
    amount: 73000,
    issued: ISSUED,
    due: "2026-10-01",
    status: "PENDING",
    expected: "REJECTED_FIELD:dueOn",
    note: "Vencimiento anterior a la emisión",
  },
  {
    id: "d09",
    group: "{{GROUP}}",
    businessId: null,
    supplier: "Limpieza Horizonte Demo",
    amount: 51000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:businessId",
    note: "Número de factura vacío",
  },
  {
    id: "d10",
    group: "{{GROUP}}",
    businessId: `{{RUN}}-${"X".repeat(90)}`,
    supplier: "Imprenta Isla Demo",
    amount: 38000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED_FIELD:businessId",
    note: "Número de factura demasiado largo (máx. 80)",
  },
  {
    id: "d11",
    group: "{{GROUP}}",
    businessId: "{{RUN}}-001",
    supplier: "Ferretería Aurora Demo",
    amount: 185000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "REJECTED:BUSINESS_ID_CONFLICT",
    note: "Duplicado de d01: la API lo rechaza",
  },
  {
    id: "d12",
    group: "{{UNKNOWN_GROUP}}",
    businessId: "{{RUN}}-012",
    supplier: "Consultores Jade Demo",
    amount: 120000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "ERROR:GROUP_NOT_FOUND",
    note: "Grupo que la cuenta no tiene",
  },
  {
    id: "d13",
    group: "",
    businessId: "{{RUN}}-013",
    supplier: "Servicios Omega Demo",
    amount: 56000,
    issued: ISSUED,
    due: DUE,
    status: "PENDING",
    expected: "CREATED",
    note: "Sin grupo: creación a nivel de organización",
  },
];

/** Variant name -> rows. The file written is `<variant>.xlsx` next to this one. */
export const variants = {
  "invoice-batch": invoiceBatchRows,
  "demo-batch": demoRows,
} as const;
export type Variant = keyof typeof variants;

export async function writeFixture(
  rows: readonly FixtureRow[],
  target: string,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("invoices");
  sheet.addRow([...INPUT_COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    const values: Record<(typeof INPUT_COLUMNS)[number], Cell> = {
      row_id: row.id,
      organization: "{{ORG}}",
      group: row.group ?? null,
      business_id: row.businessId,
      supplier_name: row.supplier ?? null,
      amount_pesos: row.amount ?? null,
      issued_on: row.issued ?? null,
      due_on: row.due ?? null,
      status: row.status ?? null,
      expected: row.expected,
      fault: row.fault ?? null,
      note: row.note,
    };
    sheet.addRow(INPUT_COLUMNS.map((name) => values[name]));
  }
  for (const key of ["G", "H"]) sheet.getColumn(key).numFmt = "yyyy-mm-dd";
  sheet.columns.forEach((column) => {
    column.width = 20;
  });

  await workbook.xlsx.writeFile(target);
}

if (import.meta.main) {
  const variant = process.argv[2] ?? "invoice-batch";
  if (!(variant in variants))
    throw new Error(
      `Unknown variant "${variant}" (${Object.keys(variants).join(", ")})`,
    );
  const target = resolve(import.meta.dirname, `${variant}.xlsx`);
  await writeFixture(variants[variant as Variant], target);
  console.log(`Wrote ${target} (${variants[variant as Variant].length} rows)`);
}
