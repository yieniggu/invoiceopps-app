import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readInputRows } from "../excel.ts";
import { variants, writeFixture } from "./build-invoice-batch.ts";

const PLACEHOLDERS = ["ORG", "GROUP", "UNKNOWN_GROUP", "RUN"];

async function build(variant: keyof typeof variants) {
  const dir = mkdtempSync(join(tmpdir(), "rpa-fixture-"));
  try {
    const target = join(dir, `${variant}.xlsx`);
    await writeFixture(variants[variant], target);
    return await readInputRows(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("demo-batch has 10 to 13 rows, none with a fault, each with an expectation", async () => {
  const rows = await build("demo-batch");
  assert.ok(rows.length >= 10 && rows.length <= 13, `${rows.length} rows`);
  assert.equal(rows.length, variants["demo-batch"].length);
  for (const row of rows) {
    assert.equal(row.fault, "", `${row.rowId} must not carry a fault`);
    assert.notEqual(row.expected, "", `${row.rowId} lacks expected`);
  }
});

test("demo-batch covers created, rejected, duplicate and unavailable-scope cases", async () => {
  const rows = await build("demo-batch");
  const expected = rows.map((row) => row.expected);
  assert.ok(expected.filter((value) => value === "CREATED").length >= 4);
  for (const wanted of [
    "REJECTED_FIELD:supplierName",
    "REJECTED_FIELD:amount",
    "REJECTED_FIELD:dueOn",
    "REJECTED_FIELD:businessId",
    "REJECTED:BUSINESS_ID_CONFLICT",
    "ERROR:GROUP_NOT_FOUND",
  ])
    assert.ok(expected.includes(wanted), `missing ${wanted}`);
  assert.ok(rows.some((row) => row.group === "{{GROUP}}"));
  assert.ok(rows.some((row) => row.group === ""));
  assert.ok(new Set(rows.map((row) => row.status)).size >= 3);
});

test("demo-batch keeps every placeholder the demo fills", async () => {
  const rows = await build("demo-batch");
  const text = rows
    .flatMap((row) => Object.values(row))
    .map(String)
    .join("\n");
  for (const key of PLACEHOLDERS)
    assert.ok(text.includes(`{{${key}}}`), `missing {{${key}}}`);
});

test("demo-batch has a business id longer than the 80 characters the API accepts", async () => {
  const rows = await build("demo-batch");
  assert.ok(rows.some((row) => row.businessId.length > 80));
});

test("invoice-batch still carries its fault rows", async () => {
  const rows = await build("invoice-batch");
  assert.equal(rows.length, 16);
  const faults = new Set(rows.map((row) => row.fault).filter(Boolean));
  assert.equal(faults.size, 7);
});
