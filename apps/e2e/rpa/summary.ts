/**
 * Run summary of the RPA demo: pure functions, no I/O. The demo spec feeds
 * them the output table of the bot (`readOutputTable`) plus what the API holds,
 * and writes `summary.json` and `summary.md` from the result.
 */

import { invoiceMismatches, type ApiInvoice } from "./matching.ts";

/**
 * The columns of the output workbook that the summary reads. The `CREATED`
 * rows are also checked against what the API holds, which needs what the row
 * asked for and the id the bot reported (all optional: absent reads as blank).
 */
export interface SummaryRowInput {
  row_id: string;
  business_id: string;
  expected: string;
  result: string;
  field: string;
  error_code: string;
  invoice_id?: string;
  group?: string;
  supplier_name?: string;
  amount_pesos?: string;
  issued_on?: string;
  due_on?: string;
}

/** A row of `readOutputTable` as a typed summary row (missing cells are blank). */
export function toSummaryRow(record: Readonly<Record<string, string>>) {
  const read = (name: string) => record[name] ?? "";
  const row: SummaryRowInput = {
    row_id: read("row_id"),
    business_id: read("business_id"),
    expected: read("expected"),
    result: read("result"),
    field: read("field"),
    error_code: read("error_code"),
    invoice_id: read("invoice_id"),
    group: read("group"),
    supplier_name: read("supplier_name"),
    amount_pesos: read("amount_pesos"),
    issued_on: read("issued_on"),
    due_on: read("due_on"),
  };
  return row;
}

export interface SummaryInput {
  runId: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  rows: readonly SummaryRowInput[];
  /** Invoices the API holds per business id (0 when none). */
  persisted: Readonly<Record<string, number>>;
  /**
   * The invoices themselves (API items). With them, every CREATED row must
   * match its stored invoice field by field; without them only counts are checked.
   */
  invoices?: readonly ApiInvoice[];
  /** The organization the run created invoices in (scope check). */
  organizationId?: string;
  /** Group name of the Excel -> group id, to check the scope of group rows. */
  groupIdsByName?: Readonly<Record<string, string>>;
  /** Where the evidence of the run lives (video, trace, workbook...). */
  artifacts?: Readonly<Record<string, string>>;
}

export interface SummaryRow {
  rowId: string;
  businessId: string;
  expected: string;
  result: string;
  /** Field name or error code that the bot reported, if any. */
  detail: string;
  ok: boolean;
  /** Invoices stored under this row's business id. */
  stored: number;
  /**
   * CREATED rows, when `invoices` was given: whether the stored invoice is the
   * one the row describes (`id` included) and the fields that differ.
   */
  persistedMatches?: { ok: boolean; mismatches: string[] };
}

export interface RunSummary {
  runId: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: { rows: number; matched: number; mismatched: number };
  countsByResult: Record<string, number>;
  countsByExpected: Record<string, number>;
  createdCount: number;
  persistedCount: number;
  persistedMatchesCreated: boolean;
  ok: boolean;
  rows: SummaryRow[];
  artifacts: Record<string, string>;
}

/** `RESULT` or `RESULT:detail` (field name or error code). */
export function parseExpected(expected: string) {
  const [result = "", detail = ""] = expected.split(":");
  return { result, detail };
}

const isCreated = (result: string) => result.startsWith("CREATED");

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** The result matches, and so does the field or error code when one is named. */
function matches(row: SummaryRowInput): boolean {
  const { result, detail } = parseExpected(row.expected);
  if (row.result !== result) return false;
  if (result === "REJECTED_FIELD") return row.field === detail;
  if (result === "REJECTED" || result === "SKIPPED")
    return row.error_code === detail;
  return true;
}

/** `id` is `invoice_id` of the output; everything else is compared with the row. */
function persistedMatches(
  row: SummaryRowInput,
  input: SummaryInput,
  invoices: readonly ApiInvoice[],
): { ok: boolean; mismatches: string[] } {
  const invoiceId = row.invoice_id ?? "";
  const item = invoices.find((candidate) => candidate.id === invoiceId);
  if (!item) {
    const other = invoices.some(
      (candidate) => candidate.businessId === row.business_id,
    );
    return { ok: false, mismatches: [other ? "id" : "missing"] };
  }
  const group = row.group ?? "";
  let groupId: string | null | undefined;
  if (group === "") groupId = null;
  else if (input.groupIdsByName)
    groupId = input.groupIdsByName[group] ?? "(unknown group)";
  const mismatches = invoiceMismatches(
    {
      businessId: row.business_id,
      supplierName: row.supplier_name ?? "",
      amountPesos: row.amount_pesos ?? "",
      issuedOn: row.issued_on ?? "",
      dueOn: row.due_on ?? "",
      organizationId: input.organizationId,
      groupId,
    },
    item,
  );
  return { ok: mismatches.length === 0, mismatches };
}

export function buildSummary(input: SummaryInput): RunSummary {
  const countsByResult: Record<string, number> = {};
  const countsByExpected: Record<string, number> = {};
  const createdByBusinessId = new Map<string, number>();
  const rows: SummaryRow[] = input.rows.map((row) => {
    increment(countsByResult, row.result);
    increment(countsByExpected, parseExpected(row.expected).result);
    if (isCreated(row.result) && row.business_id)
      createdByBusinessId.set(
        row.business_id,
        (createdByBusinessId.get(row.business_id) ?? 0) + 1,
      );
    return {
      rowId: row.row_id,
      businessId: row.business_id,
      expected: row.expected,
      result: row.result,
      detail: row.result === "REJECTED_FIELD" ? row.field : row.error_code,
      ok: matches(row),
      stored: input.persisted[row.business_id] ?? 0,
      ...(input.invoices && isCreated(row.result)
        ? { persistedMatches: persistedMatches(row, input, input.invoices) }
        : {}),
    };
  });

  const createdCount = input.rows.filter((row) => isCreated(row.result)).length;
  const persistedCount = Object.values(input.persisted).reduce(
    (sum, count) => sum + count,
    0,
  );
  // The totals agree AND every business id holds exactly what was created for it.
  const businessIds = new Set([
    ...Object.keys(input.persisted),
    ...createdByBusinessId.keys(),
  ]);
  const persistedMatchesCreated =
    persistedCount === createdCount &&
    [...businessIds].every(
      (id) => (input.persisted[id] ?? 0) === (createdByBusinessId.get(id) ?? 0),
    ) &&
    rows.every((row) => row.persistedMatches?.ok ?? true);

  const matched = rows.filter((row) => row.ok).length;
  return {
    runId: input.runId,
    baseUrl: input.baseUrl,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Date.parse(input.finishedAt) - Date.parse(input.startedAt),
    totals: { rows: rows.length, matched, mismatched: rows.length - matched },
    countsByResult,
    countsByExpected,
    createdCount,
    persistedCount,
    persistedMatchesCreated,
    // An empty batch proves nothing: it is never a success.
    ok: rows.length > 0 && matched === rows.length && persistedMatchesCreated,
    rows,
    artifacts: { ...input.artifacts },
  };
}

const mark = (ok: boolean) => (ok ? "✓" : "✗");
const cell = (value: string) => value.replaceAll("|", "\\|") || "—";
const MAX_ID = 28;
const shorten = (value: string) =>
  value.length > MAX_ID ? `${value.slice(0, MAX_ID - 1)}…` : value;

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

function countList(counts: Readonly<Record<string, number>>) {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `- ${key}: ${count}`)
    .join("\n");
}

/** Spanish report meant to be projected in class. */
export function renderSummaryMarkdown(summary: RunSummary): string {
  const lines = [
    `# Resumen de la demo RPA`,
    "",
    `Resultado global: ${mark(summary.ok)}`,
    "",
    `- Corrida: ${summary.runId}`,
    `- Aplicación: ${summary.baseUrl}`,
    `- Inicio: ${summary.startedAt}`,
    `- Fin: ${summary.finishedAt}`,
    `- Duración: ${seconds(summary.durationMs)}`,
    `- Filas: ${summary.totals.rows} (coinciden ${summary.totals.matched}, difieren ${summary.totals.mismatched})`,
    `- Facturas creadas por el bot: ${summary.createdCount}`,
    `- Facturas guardadas en la API: ${summary.persistedCount} ${mark(summary.persistedMatchesCreated)}`,
    "",
    "## Resultados obtenidos",
    "",
    countList(summary.countsByResult),
    "",
    "## Resultados esperados",
    "",
    countList(summary.countsByExpected),
    "",
    "## Detalle por fila",
    "",
    "| business_id | esperado | resultado | ok | en API |",
    "| --- | --- | --- | --- | --- |",
    ...summary.rows.map(
      (row) =>
        `| ${cell(shorten(row.businessId))} | ${cell(row.expected)} | ${cell(
          row.detail ? `${row.result}:${row.detail}` : row.result,
        )} | ${mark(row.ok)} | ${row.stored}${
          row.persistedMatches ? ` ${mark(row.persistedMatches.ok)}` : ""
        } |`,
    ),
  ];
  const differences = summary.rows.filter(
    (row) => row.persistedMatches && !row.persistedMatches.ok,
  );
  if (differences.length > 0)
    lines.push(
      "",
      "## Diferencias con la API",
      "",
      ...differences.map(
        (row) =>
          `- ${cell(shorten(row.businessId))}: ${row.persistedMatches?.mismatches.join(", ")}`,
      ),
    );
  const artifacts = Object.entries(summary.artifacts);
  if (artifacts.length > 0)
    lines.push(
      "",
      "## Evidencia",
      "",
      ...artifacts.map(([name, path]) => `- ${name}: ${path}`),
    );
  return `${lines.join("\n")}\n`;
}
