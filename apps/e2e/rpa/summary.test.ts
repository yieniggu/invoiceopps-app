import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSummary,
  parseExpected,
  renderSummaryMarkdown,
  toSummaryRow,
  type SummaryInput,
} from "./summary.ts";
import type { ApiInvoice } from "./matching.ts";

type Row = SummaryInput["rows"][number];

const row = (overrides: Partial<Row>): Row => ({
  row_id: "d01",
  business_id: "RPA-x-001",
  expected: "CREATED",
  result: "CREATED",
  field: "",
  error_code: "",
  ...overrides,
});

const rows: Row[] = [
  row({}),
  row({ row_id: "d02", business_id: "RPA-x-002" }),
  row({
    row_id: "d03",
    business_id: "RPA-x-003",
    expected: "REJECTED_FIELD:supplierName",
    result: "REJECTED_FIELD",
    field: "supplierName",
  }),
  row({
    row_id: "d04",
    business_id: "RPA-x-001",
    expected: "REJECTED:BUSINESS_ID_CONFLICT",
    result: "REJECTED",
    error_code: "BUSINESS_ID_CONFLICT",
  }),
  row({
    row_id: "d05",
    business_id: "RPA-x-005",
    expected: "SKIPPED:SCOPE_NOT_AVAILABLE",
    result: "SKIPPED",
    error_code: "SCOPE_NOT_AVAILABLE",
  }),
];

const base = {
  runId: "RPA-x",
  baseUrl: "http://127.0.0.1:5391",
  startedAt: "2026-11-19T10:00:00.000Z",
  finishedAt: "2026-11-19T10:00:42.500Z",
  persisted: { "RPA-x-001": 1, "RPA-x-002": 1, "RPA-x-003": 0, "RPA-x-005": 0 },
};

test("parseExpected splits RESULT and detail", () => {
  assert.deepEqual(parseExpected("CREATED"), { result: "CREATED", detail: "" });
  assert.deepEqual(parseExpected("REJECTED:BUSINESS_ID_CONFLICT"), {
    result: "REJECTED",
    detail: "BUSINESS_ID_CONFLICT",
  });
});

test("buildSummary counts results, expectations and persistence", () => {
  const summary = buildSummary({ ...base, rows });
  assert.equal(summary.runId, "RPA-x");
  assert.equal(summary.baseUrl, base.baseUrl);
  assert.equal(summary.durationMs, 42_500);
  assert.equal(summary.totals.rows, 5);
  assert.equal(summary.totals.matched, 5);
  assert.equal(summary.totals.mismatched, 0);
  assert.deepEqual(summary.countsByResult, {
    CREATED: 2,
    REJECTED_FIELD: 1,
    REJECTED: 1,
    SKIPPED: 1,
  });
  assert.equal(summary.createdCount, 2);
  assert.equal(summary.persistedCount, 2);
  assert.equal(summary.persistedMatchesCreated, true);
  assert.equal(summary.ok, true);
  assert.deepEqual(
    summary.rows.map((entry) => entry.ok),
    [true, true, true, true, true],
  );
});

test("buildSummary flags a result that differs from expected", () => {
  const wrong = rows.map((entry) =>
    entry.row_id === "d03" ? { ...entry, result: "CREATED", field: "" } : entry,
  );
  const summary = buildSummary({
    ...base,
    rows: wrong,
    persisted: { ...base.persisted, "RPA-x-003": 1 },
  });
  assert.equal(summary.totals.mismatched, 1);
  assert.equal(summary.rows.find((r) => r.rowId === "d03")?.ok, false);
  assert.equal(summary.ok, false);
});

test("buildSummary flags a wrong detail even when the result matches", () => {
  const wrong = rows.map((entry) =>
    entry.row_id === "d03" ? { ...entry, field: "amount" } : entry,
  );
  const summary = buildSummary({ ...base, rows: wrong });
  assert.equal(summary.rows.find((r) => r.rowId === "d03")?.ok, false);
  assert.equal(summary.ok, false);
});

test("buildSummary flags persistence that differs from CREATED", () => {
  const summary = buildSummary({
    ...base,
    rows,
    persisted: { ...base.persisted, "RPA-x-002": 0 },
  });
  assert.equal(summary.persistedCount, 1);
  assert.equal(summary.persistedMatchesCreated, false);
  assert.equal(summary.ok, false);
});

test("buildSummary flags a duplicate stored twice", () => {
  const summary = buildSummary({
    ...base,
    rows,
    persisted: { ...base.persisted, "RPA-x-001": 2 },
  });
  assert.equal(summary.persistedMatchesCreated, false);
  assert.equal(summary.ok, false);
});

test("renderSummaryMarkdown renders a Spanish table with a mark per row", () => {
  const summary = buildSummary({
    ...base,
    rows: rows.map((entry) =>
      entry.row_id === "d05"
        ? { ...entry, result: "CREATED", error_code: "" }
        : entry,
    ),
  });
  const markdown = renderSummaryMarkdown(summary);
  assert.match(markdown, /^# Resumen de la demo RPA/);
  assert.ok(markdown.includes("RPA-x"));
  assert.ok(markdown.includes(base.baseUrl));
  assert.ok(markdown.includes("42,5 s"));
  assert.match(markdown, /\| business_id \| esperado \| resultado \| ok \|/);
  assert.match(markdown, /\| RPA-x-002 \| CREATED \| CREATED \| ✓ \|/);
  assert.match(
    markdown,
    /\| RPA-x-005 \| SKIPPED:SCOPE_NOT_AVAILABLE \| CREATED \| ✗ \|/,
  );
  assert.ok(markdown.includes("Resultado global: ✗"));
});

test("renderSummaryMarkdown reports success when everything matches", () => {
  const markdown = renderSummaryMarkdown(buildSummary({ ...base, rows }));
  assert.ok(markdown.includes("Resultado global: ✓"));
  assert.ok(!markdown.includes("✗"));
});

test("the detail of a row is the field for REJECTED_FIELD and the code otherwise", () => {
  const summary = buildSummary({
    ...base,
    rows: [
      row({
        row_id: "a",
        expected: "REJECTED:BUSINESS_ID_CONFLICT",
        result: "REJECTED",
        field: "businessId",
        error_code: "BUSINESS_ID_CONFLICT",
      }),
      row({
        row_id: "b",
        expected: "REJECTED_FIELD:amount",
        result: "REJECTED_FIELD",
        field: "amount",
        error_code: "",
      }),
    ],
    persisted: {},
  });
  assert.deepEqual(
    summary.rows.map((entry) => entry.detail),
    ["BUSINESS_ID_CONFLICT", "amount"],
  );
  const markdown = renderSummaryMarkdown(summary);
  assert.ok(markdown.includes("| REJECTED:BUSINESS_ID_CONFLICT |"));
});

test("renderSummaryMarkdown shortens a very long business id", () => {
  const long = `RPA-x-${"X".repeat(90)}`;
  const markdown = renderSummaryMarkdown(
    buildSummary({
      ...base,
      rows: [row({ business_id: long })],
      persisted: { [long]: 1 },
    }),
  );
  assert.ok(!markdown.includes(long));
  assert.match(markdown, /\| RPA-x-X+… \| CREATED/);
});

test("an empty batch is never a success", () => {
  const summary = buildSummary({ ...base, rows: [], persisted: {} });
  assert.equal(summary.totals.rows, 0);
  assert.equal(summary.ok, false);
  assert.ok(renderSummaryMarkdown(summary).includes("Resultado global: ✗"));
});

test("a CREATED row without business_id is counted but can not be matched to the API", () => {
  const summary = buildSummary({
    ...base,
    rows: [row({ row_id: "z", business_id: "" })],
    persisted: {},
  });
  assert.equal(summary.createdCount, 1);
  assert.equal(summary.persistedMatchesCreated, false);
  assert.equal(summary.ok, false);
  assert.equal(summary.rows[0]?.stored, 0);
  assert.match(renderSummaryMarkdown(summary), /\| — \| CREATED \| CREATED \|/);
});

test("CREATED_AFTER_RETRY and CREATED_RECONCILED count as created", () => {
  const summary = buildSummary({
    ...base,
    rows: [
      row({
        row_id: "a",
        business_id: "RPA-x-010",
        expected: "CREATED_AFTER_RETRY",
        result: "CREATED_AFTER_RETRY",
      }),
      row({
        row_id: "b",
        business_id: "RPA-x-011",
        expected: "CREATED_RECONCILED",
        result: "CREATED_RECONCILED",
      }),
    ],
    persisted: { "RPA-x-010": 1, "RPA-x-011": 1 },
  });
  assert.equal(summary.createdCount, 2);
  assert.equal(summary.persistedMatchesCreated, true);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.countsByResult, {
    CREATED_AFTER_RETRY: 1,
    CREATED_RECONCILED: 1,
  });
});

test("persisted business ids that no row mentions break the match", () => {
  const summary = buildSummary({
    ...base,
    rows,
    persisted: { ...base.persisted, "RPA-x-999": 1 },
  });
  assert.equal(summary.persistedCount, 3);
  assert.equal(summary.persistedMatchesCreated, false);
  assert.equal(summary.ok, false);
});

const invoice = (overrides: Partial<ApiInvoice> = {}): ApiInvoice => ({
  id: "inv-1",
  businessId: "RPA-x-001",
  supplierName: "Proveedor Uno",
  amountPesos: 320000,
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  organizationId: "org-1",
  groupId: null,
  ...overrides,
});

const detailed = (overrides: Partial<Row> = {}): Row =>
  row({
    invoice_id: "inv-1",
    group: "",
    supplier_name: "Proveedor Uno",
    amount_pesos: "320.000",
    issued_on: "2026-10-25",
    due_on: "2026-11-25",
    ...overrides,
  });

const withApi = (items: ApiInvoice[], rowOverrides: Partial<Row> = {}) =>
  buildSummary({
    ...base,
    rows: [detailed(rowOverrides)],
    persisted: { "RPA-x-001": items.length },
    invoices: items,
    organizationId: "org-1",
    groupIdsByName: { Compras: "grp-1" },
  });

test("a CREATED row whose stored invoice matches is persistedMatches ok", () => {
  const summary = withApi([invoice()]);
  assert.deepEqual(summary.rows[0]?.persistedMatches, {
    ok: true,
    mismatches: [],
  });
  assert.equal(summary.ok, true);
});

test("a group row matches the group id of its name", () => {
  const summary = withApi([invoice({ groupId: "grp-1" })], {
    group: "Compras",
  });
  assert.equal(summary.rows[0]?.persistedMatches?.ok, true);
  const wrong = withApi([invoice({ groupId: null })], { group: "Compras" });
  assert.deepEqual(wrong.rows[0]?.persistedMatches?.mismatches, ["groupId"]);
});

test("every differing field of the stored invoice is reported and fails the run", () => {
  const summary = withApi([
    invoice({
      supplierName: "Otro",
      amountPesos: 1,
      issuedOn: "2026-01-01",
      dueOn: "2026-02-02",
      organizationId: "org-2",
      groupId: "grp-9",
    }),
  ]);
  assert.deepEqual(summary.rows[0]?.persistedMatches?.mismatches, [
    "supplierName",
    "amountPesos",
    "issuedOn",
    "dueOn",
    "organizationId",
    "groupId",
  ]);
  assert.equal(summary.persistedMatchesCreated, false);
  assert.equal(summary.ok, false);
  const markdown = renderSummaryMarkdown(summary);
  assert.match(markdown, /## Diferencias con la API/);
  assert.match(markdown, /RPA-x-001: supplierName, amountPesos/);
  assert.match(markdown, /\| 1 ✗ \|/);
});

test("the stored id must be the invoice_id of the output", () => {
  const swapped = withApi([invoice({ id: "inv-other" })]);
  assert.deepEqual(swapped.rows[0]?.persistedMatches, {
    ok: false,
    mismatches: ["id"],
  });
  const absent = withApi([invoice({ businessId: "RPA-x-zzz", id: "inv-z" })]);
  assert.deepEqual(absent.rows[0]?.persistedMatches?.mismatches, ["missing"]);
  assert.equal(absent.ok, false);
});

test("toSummaryRow types an output table row, blank when a cell is missing", () => {
  assert.deepEqual(
    toSummaryRow({ row_id: "r1", result: "CREATED", business_id: "B" }),
    {
      row_id: "r1",
      business_id: "B",
      expected: "",
      result: "CREATED",
      field: "",
      error_code: "",
      invoice_id: "",
      group: "",
      supplier_name: "",
      amount_pesos: "",
      issued_on: "",
      due_on: "",
    },
  );
});
