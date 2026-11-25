import { writeFile as writeFileToDisk } from "node:fs/promises";

import ExcelJS from "exceljs";

import { InputError } from "./args.ts";
import { writeAtomically } from "./atomic.ts";

/**
 * Input header row, snake_case. The first nine are what the bot works from and
 * are required; `expected`, `fault` and `note` are optional (the harness reads
 * them, the bot never does) and read as empty when the sheet lacks them.
 */
export const INPUT_COLUMNS = [
  "row_id",
  "organization",
  "group",
  "business_id",
  "supplier_name",
  "amount_pesos",
  "issued_on",
  "due_on",
  "status",
  "expected",
  "fault",
  "note",
] as const;

const OPTIONAL_COLUMNS = ["expected", "fault", "note"] as const;

export const RESULT_COLUMNS = [
  "result",
  "invoice_id",
  "error_kind",
  "error_status",
  "error_code",
  "field",
  "message",
  "attempts",
  "finished_at",
] as const;

export const RESULTS = [
  "CREATED",
  "CREATED_AFTER_RETRY",
  "CREATED_RECONCILED",
  "REJECTED_FIELD",
  "REJECTED",
  "ERROR",
  "SKIPPED",
  "UNCERTAIN",
  "MANUAL_REVIEW",
  "NOT_PROCESSED",
] as const;
export type ResultCode = (typeof RESULTS)[number];

type InputColumn = (typeof INPUT_COLUMNS)[number];
type ResultColumn = (typeof RESULT_COLUMNS)[number];

/** What the bot works from. Plain text, exactly as the person typed it. */
export interface BotRow {
  rowId: string;
  organization: string;
  /** Blank means the organization scope. */
  group: string;
  businessId: string;
  supplierName: string;
  amountPesos: string;
  issuedOn: string;
  dueOn: string;
  status: string;
}

/** A sheet row: the bot's input plus the harness-only columns. */
export interface InputRow extends BotRow {
  expected: string;
  fault: string;
  note: string;
}

export interface RowOutcome {
  rowId: string;
  result: ResultCode;
  invoiceId: string;
  errorKind: string;
  errorStatus: string;
  errorCode: string;
  field: string;
  /** The UI text, for humans and logs only; nothing decides on it. */
  message: string;
  attempts: number;
  finishedAt: string;
}

const SHEET = "invoices";

/** Day count of the Excel serial epoch (1899-12-30) in milliseconds. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

function isoDay(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** A cell as plain text; rich text, formula results and hyperlinks included. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return isoDay(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (typeof value === "string") return value.trim();
  if ("richText" in value)
    return value.richText
      .map((part) => part.text)
      .join("")
      .trim();
  if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
  if ("text" in value) return String(value.text).trim();
  return "";
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An ISO day that exists in the calendar (2026-02-31 does not). The shape is
 * not enough: a date input throws on `fill` for an impossible day.
 */
export function isCalendarDay(text: string): boolean {
  const match = ISO_DAY.exec(text);
  if (!match) return false;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  // `Date.UTC` maps years 0-99 to 1900-1999; the round trip catches it too.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Serials a person can mean as an invoice date: 1990-01-01 to 2100-12-31. */
const MIN_SERIAL = (Date.UTC(1990, 0, 1) - EXCEL_EPOCH) / DAY_MS;
const MAX_SERIAL = (Date.UTC(2100, 11, 31) - EXCEL_EPOCH) / DAY_MS;

/**
 * `yyyy-MM-dd` from an Excel date, a serial number or typed text. Whatever is
 * not a real day (or a plausible serial) goes through as typed, so the UI
 * validation reports the field instead of the bot guessing.
 */
export function normalizeDate(value: ExcelJS.CellValue): string {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "" : isoDay(value);
  if (typeof value === "number") {
    // The fraction is the time of day: it never moves the date.
    const serial = Math.floor(value);
    if (!Number.isFinite(serial) || serial < MIN_SERIAL || serial > MAX_SERIAL)
      return String(value);
    return isoDay(new Date(EXCEL_EPOCH + serial * DAY_MS));
  }
  const text = cellText(value);
  // The one place that decides what a real day is; an impossible one (even
  // when ISO-shaped) falls through and goes out as typed.
  if (isCalendarDay(text)) return text;
  const slashed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (slashed) {
    const iso = `${slashed[3]}-${pad(Number(slashed[2]))}-${pad(Number(slashed[1]))}`;
    return isCalendarDay(iso) ? iso : text;
  }
  const serial = /^\d{5}$/.exec(text);
  if (serial) return normalizeDate(Number(text));
  return text;
}

/** A number becomes its digits; text stays as typed (`12.500`, `12500,5`). */
function normalizeAmount(value: ExcelJS.CellValue): string {
  if (typeof value === "number") return String(value);
  return cellText(value);
}

function headerIndex(sheet: ExcelJS.Worksheet): Map<string, number> {
  const index = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    index.set(cellText(cell.value).toLowerCase(), column);
  });
  const missing = INPUT_COLUMNS.filter(
    (name) =>
      !index.has(name) &&
      !(OPTIONAL_COLUMNS as readonly string[]).includes(name),
  );
  if (missing.length > 0)
    throw new InputError(
      `The input sheet lacks columns: ${missing.join(", ")}`,
    );
  return index;
}

export async function readInputRows(path: string): Promise<InputRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path);
  } catch (error) {
    throw new InputError(
      `Can not read the input workbook "${path}": ${(error as Error).message}`,
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new InputError("The input workbook has no sheets");
  const columns = headerIndex(sheet);
  const rows: InputRow[] = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const raw = (name: InputColumn): ExcelJS.CellValue => {
      const column = columns.get(name);
      return column === undefined ? null : row.getCell(column).value;
    };
    const text = (name: InputColumn) => cellText(raw(name));
    if (INPUT_COLUMNS.every((name) => text(name) === "")) continue;
    rows.push({
      rowId: text("row_id") || String(number - 1),
      organization: text("organization"),
      group: text("group"),
      businessId: text("business_id"),
      supplierName: text("supplier_name"),
      amountPesos: normalizeAmount(raw("amount_pesos")),
      issuedOn: normalizeDate(raw("issued_on")),
      dueOn: normalizeDate(raw("due_on")),
      status: text("status"),
      expected: text("expected"),
      fault: text("fault"),
      note: text("note"),
    });
  }
  assertUniqueRowIds(rows);
  return rows;
}

/** Rows share outcomes, scopes and output lines by `row_id`: it must be unique. */
function assertUniqueRowIds(rows: readonly InputRow[]): void {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const { rowId } of rows) {
    if (seen.has(rowId)) duplicated.add(rowId);
    seen.add(rowId);
  }
  if (duplicated.size > 0)
    throw new InputError(
      `Duplicate row_id in the input sheet: ${[...duplicated].map((id) => `"${id}"`).join(", ")}. A blank row_id falls back to its data row number, which can collide with an explicit one.`,
    );
}

/** The harness-only columns never reach the bot. */
export const toBotRow = (row: InputRow): BotRow => ({
  rowId: row.rowId,
  organization: row.organization,
  group: row.group,
  businessId: row.businessId,
  supplierName: row.supplierName,
  amountPesos: row.amountPesos,
  issuedOn: row.issuedOn,
  dueOn: row.dueOn,
  status: row.status,
});

/**
 * Output workbook: the input columns followed by the result columns. Written
 * to `<path>.tmp-<pid>` and renamed, so an interrupted write never leaves a
 * truncated workbook (see atomic.ts). `writeFile` is injectable for tests.
 */
export async function writeOutput(
  path: string,
  rows: readonly InputRow[],
  outcomes: readonly RowOutcome[],
  writeFile: (
    workbook: ExcelJS.Workbook,
    tempPath: string,
  ) => Promise<unknown> = (workbook, tempPath) =>
    // Serialize in memory and write into the exclusively created temp file:
    // ExcelJS' own writeFile would open the path itself and follow a symlink.
    workbook.xlsx.writeBuffer().then((buffer: ExcelJS.Buffer) =>
      // writeBuffer already returns a Buffer in Node: write it as is, and
      // only wrap (without a second copy) when it is a bare ArrayBuffer.
      writeFileToDisk(
        tempPath,
        Buffer.isBuffer(buffer)
          ? buffer
          : new Uint8Array(buffer as ArrayBuffer),
      ),
    ),
): Promise<void> {
  const byRow = new Map(outcomes.map((outcome) => [outcome.rowId, outcome]));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(SHEET);
  sheet.addRow([...INPUT_COLUMNS, ...RESULT_COLUMNS]);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    const outcome = byRow.get(row.rowId);
    const input: Record<InputColumn, string> = {
      row_id: row.rowId,
      organization: row.organization,
      group: row.group,
      business_id: row.businessId,
      supplier_name: row.supplierName,
      amount_pesos: row.amountPesos,
      issued_on: row.issuedOn,
      due_on: row.dueOn,
      status: row.status,
      expected: row.expected,
      fault: row.fault,
      note: row.note,
    };
    const result: Record<ResultColumn, string | number> = {
      result: outcome?.result ?? "NOT_PROCESSED",
      invoice_id: outcome?.invoiceId ?? "",
      error_kind: outcome?.errorKind ?? "",
      error_status: outcome?.errorStatus ?? "",
      error_code: outcome?.errorCode ?? "",
      field: outcome?.field ?? "",
      message: outcome?.message ?? "",
      attempts: outcome?.attempts ?? 0,
      finished_at: outcome?.finishedAt ?? "",
    };
    sheet.addRow([
      ...INPUT_COLUMNS.map((name) => input[name]),
      ...RESULT_COLUMNS.map((name) => result[name]),
    ]);
  }
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  await writeAtomically(path, async (tempPath) => {
    await writeFile(workbook, tempPath);
  });
}

/** Reads the output sheet back as header -> values, for checks and tooling. */
export async function readOutputTable(
  path: string,
): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The output workbook has no sheets");
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => {
    headers[column - 1] = cellText(cell.value);
  });
  const rows: Array<Record<string, string>> = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    rows.push(
      Object.fromEntries(
        headers.map((header, index) => [
          header,
          cellText(row.getCell(index + 1).value),
        ]),
      ),
    );
  }
  return { headers, rows };
}

/**
 * Copies a workbook replacing `{{KEY}}` in every text cell. The committed
 * fixture is a template: runs write a filled copy and never touch it.
 */
export async function fillPlaceholders(
  source: string,
  target: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(source);
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value !== "string") return;
        cell.value = cell.value.replace(
          /\{\{([A-Z_]+)\}\}/g,
          (whole, key: string) => values[key] ?? whole,
        );
      });
    });
  }
  await workbook.xlsx.writeFile(target);
}
