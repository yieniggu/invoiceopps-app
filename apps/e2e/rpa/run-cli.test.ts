import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import ExcelJS from "exceljs";

const dir = mkdtempSync(join(tmpdir(), "rpa-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Allowlist of OS variables a child needs on Windows (and tmp dirs elsewhere);
// credentials are never copied.
const passThrough: Record<string, string> = {};
for (const name of [
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "PATHEXT",
  "COMSPEC",
]) {
  const value = process.env[name];
  if (value !== undefined) passThrough[name] = value;
}

const runCli = (args: string[]) =>
  spawnSync(process.execPath, [join(import.meta.dirname, "run.ts"), ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...passThrough,
      RPA_RUT: "11111111-1",
      RPA_PASSWORD: "x",
    },
  });

test("an input error exits 2 and prints the usage, not a stack (CR-435)", () => {
  const result = runCli([
    "--input",
    join(dir, "missing.xlsx"),
    "--output",
    join(dir, "out.xlsx"),
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not found/);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("a workbook with missing columns exits 2 with the usage (CR-435)", async () => {
  const input = join(dir, "bad.xlsx");
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Facturas").addRow(["only_column"]);
  await book.xlsx.writeFile(input);
  const result = runCli(["--input", input, "--output", join(dir, "o.xlsx")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("no arguments prints the usage and exits 2 (CR-435)", () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
