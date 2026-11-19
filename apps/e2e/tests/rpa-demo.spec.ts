import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { css, ids, inboxPath, resultsStates, attrs } from "../rpa/contract.ts";
import {
  fillPlaceholders,
  readInputRows,
  readOutputTable,
  toBotRow,
  writeOutput,
} from "../rpa/excel.ts";
import { InvoiceBatchBot } from "../rpa/invoice-batch-bot.ts";
import {
  buildSummary,
  renderSummaryMarkdown,
  toSummaryRow,
} from "../rpa/summary.ts";
import type { ApiInvoice } from "../rpa/matching.ts";
import { Api } from "../support/api.ts";
import { BASE_URL } from "../support/env.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";
import { expect, test } from "../support/test.ts";

/**
 * Classroom demo of the invoice bot (`pnpm demo:rpa`), only run by the `demo`
 * Playwright project: headed, slowed down and recorded. It uses the demo
 * fixture (valid and invalid rows, no injected faults) against the isolated
 * E2E stack, then proves with the API that the invoices exist.
 *
 * Output goes to `demo-output/<stamp>_<run>/` (video, trace, workbooks, final
 * frame and summary), NOT to `e2e-artifacts/`: the global setup empties that
 * folder on every run, and the demo keeps its previous runs (both are
 * git-ignored). The folder is outside `test-results/`, the only path CI uploads.
 *
 * The trace is recorded by hand into that folder (the `demo` project has
 * `trace: "off"`): Playwright's own trace lives in `test-results/` and the next
 * run replaces it. Trace and video show the e2e password the bot types; they
 * never leave the machine (see docs/rpa-runbook.md).
 */

const FIXTURE = resolve(import.meta.dirname, "../rpa/fixtures/demo-batch.xlsx");
const DEMO_OUTPUT = resolve(import.meta.dirname, "../demo-output");

const VIDEO = "video.webm";
const TRACE = "trace.zip";

test.describe.configure({ mode: "serial" });

test.describe("RPA demo", () => {
  test("the bot processes the demo batch and every row ends in its expected result", async ({
    page,
  }) => {
    test.setTimeout(Number(process.env.RPA_DEMO_TIMEOUT_MS ?? 420_000));

    let traceFile: string | undefined;
    let traceStopped = false;
    const scenario = await createScenario({
      members: 1,
      groups: 1,
      memberFlags: ALL_FLAGS,
    });
    try {
      const [creator] = scenario.members;
      const [group] = scenario.groups;
      const run = `RPA-${unique()}`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outputDir = resolve(DEMO_OUTPUT, `${stamp}_${run}`);
      mkdirSync(outputDir, { recursive: true });
      await page
        .context()
        .tracing.start({ screenshots: true, snapshots: true });
      traceFile = resolve(outputDir, TRACE);

      const filled = resolve(outputDir, "input.xlsx");
      await fillPlaceholders(FIXTURE, filled, {
        ORG: scenario.org.name,
        GROUP: group.name,
        UNKNOWN_GROUP: `Sin grupo ${run}`,
        RUN: run,
      });
      const rows = await readInputRows(filled);
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.filter((row) => row.fault),
        "the demo fixture has no fault rows",
      ).toHaveLength(0);

      const startedAt = new Date();
      const bot = new InvoiceBatchBot(page, {
        baseUrl: BASE_URL,
        rut: creator.credentials.rut,
        password: creator.credentials.password,
        log: (line) => console.log(`[bot] ${line}`),
      });
      // `run` never throws on a crash: the output is written, the assertions
      // below fail on the rows the bot did not finish.
      const outcomes = await bot.run(rows.map(toBotRow));
      expect(outcomes).toHaveLength(rows.length);

      const output = resolve(outputDir, "output.xlsx");
      await writeOutput(output, rows, outcomes);
      const table = await readOutputTable(output);
      expect(table.rows).toHaveLength(rows.length);

      // What the API holds: one invoice per CREATED row, none for the rest.
      const businessIds = new Set(
        table.rows.map((row) => row.business_id).filter(Boolean),
      );
      const persisted: Record<string, number> = {};
      let invoices: ApiInvoice[] = [];
      const reader = await Api.signIn(creator.credentials);
      try {
        const { items } = await reader.call<{ items: ApiInvoice[] }>(
          "get",
          `/invoices?organizationId=${scenario.org.id}&pageSize=100`,
        );
        invoices = items;
        for (const businessId of businessIds)
          persisted[businessId] = items.filter(
            (item) => item.businessId === businessId,
          ).length;
      } finally {
        await reader.dispose();
      }

      // Closing frame for the audience: the inbox with what the bot created.
      // Best effort: a crashed bot must still leave its output and summary.
      const finalShot = resolve(outputDir, "final.png");
      try {
        await page.goto(inboxPath({ organizationId: scenario.org.id }, run));
        await expect(
          page.locator(css.testId(ids.invoicesResults)),
        ).toHaveAttribute(attrs.state, resultsStates.ready);
        await page.waitForTimeout(1_500);
        await page.screenshot({ path: finalShot, fullPage: true });
      } catch (error) {
        console.warn(`No closing frame: ${(error as Error).message}`);
      }

      // Finalize the recording and the trace BEFORE the summary, so it lists
      // only what exists on disk (a failed save is marked, never promised).
      try {
        await page.close();
        await page.video()?.saveAs(resolve(outputDir, VIDEO));
      } catch (error) {
        console.warn(`No video: ${(error as Error).message}`);
      }
      try {
        await page.context().tracing.stop({ path: traceFile });
        traceStopped = true;
      } catch (error) {
        console.warn(`No trace: ${(error as Error).message}`);
      }
      const NOT_GENERATED = "no generado";
      const artifact = (file: string) =>
        existsSync(file) ? file : NOT_GENERATED;

      const summary = buildSummary({
        runId: run,
        baseUrl: BASE_URL,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        rows: table.rows.map(toSummaryRow),
        persisted,
        invoices,
        organizationId: scenario.org.id,
        groupIdsByName: { [group.name]: group.id },
        artifacts: {
          carpeta: outputDir,
          "excel de salida": output,
          ...(existsSync(finalShot) ? { captura: finalShot } : {}),
          video: artifact(resolve(outputDir, VIDEO)),
          trace: artifact(traceFile),
        },
      });
      const markdown = renderSummaryMarkdown(summary);
      const summaryPath = resolve(outputDir, "summary.md");
      await writeFile(
        resolve(outputDir, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      await writeFile(summaryPath, markdown);
      console.log(`\nSummary: ${summaryPath}\n\n${markdown}`);

      expect(bot.abort, "the demo batch ran to the end").toBeUndefined();
      for (const row of summary.rows)
        expect(row.ok, `${row.rowId} ended in ${row.result}`).toBe(true);
      for (const row of summary.rows)
        expect(
          row.persistedMatches?.mismatches ?? [],
          `${row.rowId} differs from the stored invoice`,
        ).toEqual([]);
      expect(
        summary.persistedMatchesCreated,
        `API holds ${summary.persistedCount} invoices, bot created ${summary.createdCount}`,
      ).toBe(true);
      expect(summary.ok).toBe(true);
    } finally {
      // Only reached with a live trace when the run failed before the summary.
      if (traceFile && !traceStopped)
        await page
          .context()
          .tracing.stop({ path: traceFile })
          .catch((error: unknown) =>
            console.warn(`No trace: ${(error as Error).message}`),
          );
      await scenario.dispose();
    }
  });
});
