import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import ExcelJS from "exceljs";

import { InputError } from "./args.ts";
import {
  isCalendarDay,
  normalizeDate,
  readInputRows,
  readOutputTable,
  writeOutput,
} from "./excel.ts";

const dir = mkdtempSync(join(tmpdir(), "rpa-excel-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const REQUIRED = [
  "row_id",
  "organization",
  "group",
  "business_id",
  "supplier_name",
  "amount_pesos",
  "issued_on",
  "due_on",
  "status",
];

type Cell = ExcelJS.CellValue;
let counter = 0;

async function workbook(
  header: readonly string[],
  rows: readonly Cell[][],
): Promise<string> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("invoices");
  sheet.addRow([...header]);
  for (const row of rows) sheet.addRow(row);
  counter += 1;
  const path = join(dir, `book-${counter}.xlsx`);
  await book.xlsx.writeFile(path);
  return path;
}

/** A 9-column row: row_id, org, group, business_id, supplier, amount, issued, due, status. */
const line = (overrides: Partial<Record<string, Cell>> = {}): Cell[] => {
  const base: Record<string, Cell> = {
    row_id: "r1",
    organization: "",
    group: "",
    business_id: "F-1",
    supplier_name: "Proveedor",
    amount_pesos: 1000,
    issued_on: "2026-10-25",
    due_on: "2026-11-25",
    status: "",
    ...overrides,
  };
  return REQUIRED.map((name) => base[name] ?? null);
};

const SERIAL_2026_10_25 =
  (Date.UTC(2026, 9, 25) - Date.UTC(1899, 11, 30)) / 86_400_000;

test("only the nine bot columns are required; the optional ones read as empty", async () => {
  const rows = await readInputRows(await workbook(REQUIRED, [line()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.expected, "");
  assert.equal(rows[0]?.fault, "");
  assert.equal(rows[0]?.note, "");
});

test("optional columns are read when present", async () => {
  const rows = await readInputRows(
    await workbook(
      [...REQUIRED, "expected", "note"],
      [[...line(), "CREATED", "hola"]],
    ),
  );
  assert.equal(rows[0]?.expected, "CREATED");
  assert.equal(rows[0]?.note, "hola");
  assert.equal(rows[0]?.fault, "");
});

test("a missing bot column is named in the error", async () => {
  const header = REQUIRED.filter(
    (name) => name !== "due_on" && name !== "status",
  );
  await assert.rejects(
    readInputRows(await workbook(header, [])),
    /lacks columns: due_on, status/,
  );
});

test("formula cells read their cached result", async () => {
  const path = await workbook(REQUIRED, [
    line({
      supplier_name: { formula: '"Prov"&"eedor"', result: "Proveedor" },
      amount_pesos: { formula: "500*25", result: 12500 },
    }),
  ]);
  const [row] = await readInputRows(path);
  assert.equal(row?.supplierName, "Proveedor");
  assert.equal(row?.amountPesos, "12500");
});

test("dates: Date cells, Excel serials, dd/mm/yyyy text and ISO text", async () => {
  const path = await workbook(REQUIRED, [
    line({
      row_id: "a",
      business_id: "A",
      issued_on: new Date(Date.UTC(2026, 9, 25)),
      due_on: SERIAL_2026_10_25,
    }),
    line({
      row_id: "b",
      business_id: "B",
      issued_on: "25/10/2026",
      due_on: "5-1-2027",
    }),
    line({
      row_id: "c",
      business_id: "C",
      issued_on: "2026-10-25",
      due_on: "garbage",
    }),
  ]);
  const rows = await readInputRows(path);
  assert.deepEqual(
    rows.map((r) => [r.issuedOn, r.dueOn]),
    [
      ["2026-10-25", "2026-10-25"],
      ["2026-10-25", "2027-01-05"],
      ["2026-10-25", "garbage"],
    ],
  );
  assert.equal(normalizeDate(String(SERIAL_2026_10_25)), "2026-10-25");
});

test("amounts typed as text stay as typed", async () => {
  const [row] = await readInputRows(
    await workbook(REQUIRED, [line({ amount_pesos: "320.000" })]),
  );
  assert.equal(row?.amountPesos, "320.000");
});

test("blank rows are skipped and the fallback row_id is the data row number", async () => {
  const path = await workbook(REQUIRED, [
    line({ row_id: "x1", business_id: "A" }),
    REQUIRED.map(() => null),
    line({ row_id: null, business_id: "B" }),
  ]);
  const rows = await readInputRows(path);
  assert.deepEqual(
    rows.map((r) => [r.rowId, r.businessId]),
    [
      ["x1", "A"],
      ["3", "B"],
    ],
  );
});

test("an explicit duplicate row_id is rejected, naming the id", async () => {
  const path = await workbook(REQUIRED, [
    line({ row_id: "dup", business_id: "A" }),
    line({ row_id: "ok", business_id: "B" }),
    line({ row_id: "dup", business_id: "C" }),
  ]);
  await assert.rejects(readInputRows(path), /Duplicate row_id.*"dup"/);
});

test("a blank row_id whose fallback collides with an explicit one is rejected", async () => {
  const path = await workbook(REQUIRED, [
    line({ row_id: null, business_id: "A" }),
    line({ row_id: "1", business_id: "B" }),
  ]);
  await assert.rejects(readInputRows(path), /Duplicate row_id.*"1"/);
});

test("isCalendarDay accepts real days and rejects impossible ones", () => {
  assert.equal(isCalendarDay("2026-10-25"), true);
  assert.equal(isCalendarDay("2028-02-29"), true);
  assert.equal(isCalendarDay("2026-02-29"), false);
  assert.equal(isCalendarDay("2026-02-31"), false);
  assert.equal(isCalendarDay("2026-13-01"), false);
  assert.equal(isCalendarDay("2026-00-10"), false);
  assert.equal(isCalendarDay("2026-04-31"), false);
  assert.equal(isCalendarDay("25/10/2026"), false);
  assert.equal(isCalendarDay(""), false);
});

test("an impossible calendar date is kept as typed so the UI rejects the field", () => {
  assert.equal(normalizeDate("31/02/2026"), "31/02/2026");
  assert.equal(normalizeDate("2026-02-31"), "2026-02-31");
  assert.equal(normalizeDate("29/02/2028"), "2028-02-29");
});

test("serial dates floor the time fraction instead of rounding it up", () => {
  assert.equal(normalizeDate(SERIAL_2026_10_25 + 0.75), "2026-10-25");
  assert.equal(normalizeDate(SERIAL_2026_10_25 + 0.5), "2026-10-25");
});

test("serials outside 1990-2100 are kept as text so the UI rejects them", () => {
  assert.equal(normalizeDate(1), "1");
  assert.equal(normalizeDate(32_000), "32000");
  assert.equal(normalizeDate(500_000), "500000");
  assert.equal(normalizeDate("99999"), "99999");
  assert.equal(normalizeDate(Number.NaN), "NaN");
  assert.equal(normalizeDate(32_874), "1990-01-01");
});

test("sheet shape mistakes are InputErrors (exit 2 with usage, not a stack)", async () => {
  await assert.rejects(
    readInputRows(await workbook(["row_id"], [])),
    InputError,
  );
  await assert.rejects(
    readInputRows(
      await workbook(REQUIRED, [
        line({ row_id: "dup", business_id: "A" }),
        line({ row_id: "dup", business_id: "B" }),
      ]),
    ),
    InputError,
  );
  await assert.rejects(
    readInputRows(join(dir, "does-not-exist.xlsx")),
    InputError,
  );
});

test("an invalid Date cell reads as empty, not as NaN-NaN-NaN", () => {
  assert.equal(normalizeDate(new Date("nope")), "");
});

test("writeOutput keeps the previous workbook when the write fails halfway", async () => {
  const path = join(dir, "atomic-out.xlsx");
  const row = {
    rowId: "1",
    organization: "Org",
    group: "",
    businessId: "B-1",
    supplierName: "S",
    amountPesos: "1",
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    status: "",
    expected: "",
    fault: "",
    note: "",
  };
  await writeOutput(path, [row], []);
  const before = readFileSync(path);
  await assert.rejects(
    writeOutput(path, [row], [], async (_workbook, tempPath) => {
      writeFileSync(tempPath, "truncated");
      throw new Error("killed mid-write");
    }),
    /killed mid-write/,
  );
  assert.deepEqual(readFileSync(path), before);
  assert.equal((await readOutputTable(path)).rows.length, 1);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith("atomic-out.xlsx.tmp-")),
    [],
  );
});
