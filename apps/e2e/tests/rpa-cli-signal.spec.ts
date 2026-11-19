import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  readInputRows,
  readOutputTable,
  writeOutput,
  type InputRow,
} from "../rpa/excel.ts";
import { BASE_URL } from "../support/env.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";
import { expect, test } from "../support/test.ts";

const E2E_ROOT = resolve(import.meta.dirname, "..");
const ROWS = 24;

/**
 * Process-level proof of the CLI shutdown (CR-408): the real `rpa/run.ts` runs
 * as a child against the isolated stack and receives a signal in the middle of
 * a batch. The exit code and the output workbook must be the CLI's own, not
 * Playwright's (its handlers would exit(130) racing the write).
 *
 * The bot types the generated e2e password into the login form: no trace or
 * screenshot, and the global teardown drops the ARIA snapshot of a failure
 * (SECRET_SPECS in support/global-teardown.ts).
 */
test.use({ screenshot: "off", trace: "off" });

test.describe("RPA CLI signals", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "The bot journey runs on the desktop project only",
    );
    test.setTimeout(180_000);
  });

  // `delayMs` after the first finished row: 0 lands between two rows, a few
  // hundred ms lands while the next row is being sent (UNCERTAIN).
  for (const [signal, code, delayMs] of [
    ["SIGINT", 130, 0],
    ["SIGTERM", 143, 0],
    ["SIGINT", 130, 400],
  ] as const) {
    test(`${signal} (+${delayMs}ms after row 1) exits ${code} with the output written and the rows classified`, async ({
      page: _page,
    }, testInfo) => {
      const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
      try {
        const [creator] = s.members;
        const run = `RPA-${unique()}`;
        const rows: InputRow[] = Array.from({ length: ROWS }, (_, index) => ({
          rowId: `r${index + 1}`,
          organization: s.org.name,
          group: "",
          businessId: `${run}-${index + 1}`,
          supplierName: "Proveedor Uno",
          amountPesos: "12500",
          issuedOn: "2026-10-25",
          dueOn: "2026-11-25",
          status: "",
          expected: "CREATED",
          fault: "",
          note: "",
        }));
        const input = testInfo.outputPath("input.xlsx");
        await writeOutput(input, rows, []);
        const output = testInfo.outputPath("output.xlsx");

        // Credentials only through the environment of the child, never argv or
        // logs; the rest of this process's environment (database URL...) stays out.
        const child = spawn(
          process.execPath,
          [
            "rpa/run.ts",
            "--input",
            input,
            "--output",
            output,
            "--base-url",
            BASE_URL,
          ],
          {
            cwd: E2E_ROOT,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              TMPDIR: process.env.TMPDIR,
              PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
              NO_COLOR: "1",
              RPA_RUT: creator.credentials.rut,
              RPA_PASSWORD: creator.credentials.password,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        const exited = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((done) =>
          child.on("close", (exitCode, exitSignal) =>
            done({ code: exitCode, signal: exitSignal }),
          ),
        );
        const firstRow = new Promise<void>((done) => {
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
            if (/^r1 CREATED/m.test(stdout)) done();
          });
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        try {
          await Promise.race([
            firstRow,
            exited.then(() => {
              throw new Error(
                `the CLI ended before its first row finished:\n${stdout}${stderr}`,
              );
            }),
          ]);
          if (delayMs > 0)
            await new Promise((done) => setTimeout(done, delayMs));
          child.kill(signal);
          const ended = await exited;
          expect(
            ended.signal,
            "the CLI exits by itself, not killed",
          ).toBeNull();
          expect(ended.code, `${stdout}${stderr}`).toBe(code);
        } finally {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }

        // The output exists, is a readable workbook and no temp file is left.
        expect(existsSync(output)).toBe(true);
        expect(
          readdirSync(dirname(output)).filter((name) => name.includes(".tmp-")),
        ).toEqual([]);
        const table = await readOutputTable(output);
        expect(table.rows).toHaveLength(ROWS);
        expect((await readInputRows(input)).length).toBe(ROWS);

        // Finished rows keep their real result; at most one row (the one being
        // sent) is UNCERTAIN; the rest were never started.
        const results = table.rows.map((row) => row.result);
        const firstOpen = results.findIndex((result) => result !== "CREATED");
        expect(
          firstOpen,
          "the batch did not finish before the signal",
        ).toBeGreaterThan(0);
        for (const row of table.rows.slice(0, firstOpen)) {
          expect(row.invoice_id, `${row.row_id} invoice_id`).not.toBe("");
          expect(row.finished_at, `${row.row_id} finished_at`).not.toBe("");
        }
        const rest = results.slice(firstOpen);
        expect(["UNCERTAIN", "NOT_PROCESSED"]).toContain(rest[0]);
        expect(rest.slice(1).every((r) => r === "NOT_PROCESSED")).toBe(true);
        for (const row of table.rows.slice(firstOpen))
          expect(row.error_kind, `${row.row_id} error_kind`).toBe(
            "interrupted",
          );
        console.log(
          `${signal}: ${firstOpen} finished, row ${firstOpen + 1} ${rest[0]}`,
        );
      } finally {
        await s.dispose();
      }
    });
  }
});
