import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { InvoiceBatchBot } from "../rpa/invoice-batch-bot.ts";
import {
  INPUT_COLUMNS,
  RESULT_COLUMNS,
  fillPlaceholders,
  readInputRows,
  readOutputTable,
  toBotRow,
  writeOutput,
  type InputRow,
} from "../rpa/excel.ts";
import { Api } from "../support/api.ts";
import { BASE_URL } from "../support/env.ts";
import { ALL_FLAGS, createScenario, unique } from "../support/scenario.ts";
import { expect, test } from "../support/test.ts";

const FIXTURE = resolve(
  import.meta.dirname,
  "../rpa/fixtures/invoice-batch.xlsx",
);

/** `RESULT` or `RESULT:detail` (field name or error code). */
function parseExpected(expected: string) {
  const [result = "", detail = ""] = expected.split(":");
  return { result, detail };
}

const errorBody = (code: string) =>
  JSON.stringify({ error: { code, message: "x" } });

interface Harness {
  /** Idempotency keys seen per business id. */
  keys: Map<string, string[]>;
  logins: () => number;
}

/**
 * Fault injection: the harness reads the `fault` column, the bot never does.
 * Faults hit `POST /api/v1/invoices` for the business ids that carry one.
 */
async function installFaults(
  page: Page,
  rows: readonly InputRow[],
): Promise<Harness> {
  const faults = new Map(
    rows.filter((row) => row.fault).map((row) => [row.businessId, row.fault]),
  );
  const seen = new Map<string, number>();
  const keys = new Map<string, string[]>();
  let logins = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/auth/login"
    )
      logins += 1;
  });

  await page.route("**/api/v1/invoices", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const { businessId } = request.postDataJSON() as { businessId: string };
    keys.set(businessId, [
      ...(keys.get(businessId) ?? []),
      request.headers()["idempotency-key"] ?? "",
    ]);
    const fault = faults.get(businessId);
    const count = seen.get(businessId) ?? 0;
    seen.set(businessId, count + 1);
    const json = { contentType: "application/json" };
    switch (fault) {
      case "503-once":
        if (count === 0)
          return route.fulfill({
            status: 503,
            ...json,
            body: errorBody("SERVICE_UNAVAILABLE"),
          });
        return route.fallback();
      case "network-once":
        if (count === 0) return route.abort("failed");
        return route.fallback();
      case "503-always":
        return route.fulfill({
          status: 503,
          ...json,
          body: errorBody("SERVICE_UNAVAILABLE"),
        });
      case "lost-response-always":
        // The request reaches the server once (the invoice is created), every
        // response is lost; retries never get through, so only the inbox knows.
        if (count === 0) await route.fetch();
        return route.abort("failed");
      case "idempotency-409":
        return route.fulfill({
          status: 409,
          ...json,
          body: errorBody("IDEMPOTENCY_CONFLICT"),
        });
      case "forbidden-403":
        return route.fulfill({
          status: 403,
          ...json,
          body: errorBody("FORBIDDEN"),
        });
      case "session-expired":
        if (count === 0) await page.context().clearCookies();
        return route.fallback();
      default:
        return route.fallback();
    }
  });
  return { keys, logins: () => logins };
}

/**
 * The bot types the generated e2e password into the login form: no trace or
 * screenshot (they would hold it), and the global teardown drops the ARIA
 * snapshot of a failure (SECRET_SPECS in support/global-teardown.ts).
 */
test.use({ screenshot: "off", trace: "off" });

test.describe("RPA invoice batch bot", () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "The bot journey runs on the desktop project only",
    );
    test.setTimeout(180_000);
  });

  test("every row of the fixture ends in its expected result", async ({
    page,
  }, testInfo) => {
    const s = await createScenario({
      members: 1,
      groups: 1,
      memberFlags: ALL_FLAGS,
    });
    try {
      const [creator] = s.members;
      const [group] = s.groups;
      const run = `RPA-${unique()}`;
      const filled = testInfo.outputPath("input.xlsx");
      await fillPlaceholders(FIXTURE, filled, {
        ORG: s.org.name,
        GROUP: group.name,
        UNKNOWN_GROUP: `Sin grupo ${run}`,
        RUN: run,
      });
      const rows = await readInputRows(filled);
      expect(rows.length).toBeGreaterThan(0);

      const harness = await installFaults(page, rows);
      const bot = new InvoiceBatchBot(page, {
        baseUrl: BASE_URL,
        rut: creator.credentials.rut,
        password: creator.credentials.password,
        backoffMs: 50,
      });
      const outcomes = await bot.run(rows.map(toBotRow));
      expect(outcomes).toHaveLength(rows.length);
      expect(bot.abort, "the batch ran to the end").toBeUndefined();

      const output = testInfo.outputPath("output.xlsx");
      await writeOutput(output, rows, outcomes);
      const table = await readOutputTable(output);
      for (const column of [...INPUT_COLUMNS, ...RESULT_COLUMNS])
        expect(table.headers).toContain(column);
      expect(table.rows).toHaveLength(rows.length);

      console.table(
        table.rows.map((row) => ({
          row: row.row_id,
          fault: row.fault,
          expected: row.expected,
          result: row.result,
          field: row.field,
          code: row.error_code,
          attempts: row.attempts,
        })),
      );

      for (const row of table.rows) {
        const { result, detail } = parseExpected(row.expected);
        expect(row.result, `${row.row_id} result`).toBe(result);
        if (result === "REJECTED_FIELD")
          expect(row.field, `${row.row_id} field`).toBe(detail);
        if (result === "REJECTED" || result === "SKIPPED")
          expect(row.error_code, `${row.row_id} error_code`).toBe(detail);
        if (result.startsWith("CREATED"))
          expect(row.invoice_id, `${row.row_id} invoice_id`).not.toBe("");
        expect(row.finished_at, `${row.row_id} finished_at`).not.toBe("");
        if (result !== "SKIPPED" && result !== "NOT_PROCESSED")
          expect(
            Number(row.attempts),
            `${row.row_id} attempts`,
          ).toBeGreaterThan(0);
      }

      // «Crear como operación nueva» is never pressed: one key per business id.
      const conflict = rows.find((row) => row.fault === "idempotency-409");
      expect(conflict).toBeDefined();
      const conflictKeys = harness.keys.get(conflict?.businessId ?? "") ?? [];
      expect(conflictKeys.length).toBeGreaterThan(0);
      expect(new Set(conflictKeys).size).toBe(1);

      // The login happened at the start and again after the session ended.
      expect(harness.logins()).toBe(2);

      // The API holds exactly one invoice for what was created, none for the rest.
      const reader = await Api.signIn(creator.credentials);
      try {
        const { items } = await reader.call<{
          items: Array<{ businessId: string }>;
        }>("get", `/invoices?organizationId=${s.org.id}&pageSize=100`);
        const createdIds = new Set(
          table.rows
            .filter((row) => row.result.startsWith("CREATED"))
            .map((row) => row.business_id),
        );
        for (const businessId of new Set(
          table.rows.map((row) => row.business_id).filter(Boolean),
        )) {
          const stored = items.filter(
            (item) => item.businessId === businessId,
          ).length;
          expect(stored, `${businessId} stored`).toBe(
            createdIds.has(businessId) ? 1 : 0,
          );
        }
      } finally {
        await reader.dispose();
      }
    } finally {
      await s.dispose();
    }
  });

  test("a wrong password leaves every row NOT_PROCESSED", async ({
    page,
  }, testInfo) => {
    const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
    try {
      const [creator] = s.members;
      const rows = await readInputRows(FIXTURE);
      const bot = new InvoiceBatchBot(page, {
        baseUrl: BASE_URL,
        rut: creator.credentials.rut,
        password: `${creator.credentials.password}-wrong`,
      });
      const outcomes = await bot.run(rows.map(toBotRow));
      expect(bot.abort?.kind).toBe("credentials");

      const output = testInfo.outputPath("output.xlsx");
      await writeOutput(output, rows, outcomes);
      const table = await readOutputTable(output);
      expect(table.rows).toHaveLength(rows.length);
      for (const row of table.rows) {
        expect(row.result, row.row_id).toBe("NOT_PROCESSED");
        expect(row.error_kind, row.row_id).toBe("credentials");
      }
    } finally {
      await s.dispose();
    }
  });

  test("an invalid RUT aborts the batch at once instead of waiting for a timeout", async ({
    page,
  }, testInfo) => {
    const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
    try {
      const [creator] = s.members;
      const rows = await readInputRows(FIXTURE);
      const bot = new InvoiceBatchBot(page, {
        baseUrl: BASE_URL,
        rut: "not-a-rut",
        password: creator.credentials.password,
      });
      const startedAt = Date.now();
      const outcomes = await bot.run(rows.map(toBotRow));
      // The client-side field message shows within a second; the old wait for
      // `login-error` ran out after 20 s.
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(bot.abort?.kind).toBe("credentials");

      const output = testInfo.outputPath("output.xlsx");
      await writeOutput(output, rows, outcomes);
      const table = await readOutputTable(output);
      expect(table.rows).toHaveLength(rows.length);
      for (const row of table.rows) {
        expect(row.result, row.row_id).toBe("NOT_PROCESSED");
        expect(row.error_kind, row.row_id).toBe("credentials");
      }
    } finally {
      await s.dispose();
    }
  });

  test("a calendar-invalid date rejects only its row and does not crash the batch", async ({
    page,
  }, testInfo) => {
    const s = await createScenario({ members: 1, memberFlags: ALL_FLAGS });
    try {
      const [creator] = s.members;
      const run = `RPA-${unique()}`;
      const base: InputRow = {
        rowId: "ok",
        organization: s.org.name,
        group: "",
        businessId: `${run}-ok`,
        supplierName: "Proveedor Uno",
        amountPesos: "12500",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        status: "",
        expected: "CREATED",
        fault: "",
        note: "",
      };
      // A small temp workbook, written with the same helper as the outputs:
      // the committed fixture is not regenerated for this case.
      const input = testInfo.outputPath("input.xlsx");
      await writeOutput(
        input,
        [
          base,
          {
            ...base,
            rowId: "bad-issued",
            businessId: `${run}-bad-issued`,
            issuedOn: "31/02/2026",
            expected: "REJECTED_FIELD:issuedOn",
          },
          {
            ...base,
            rowId: "bad-due",
            businessId: `${run}-bad-due`,
            dueOn: "2026-02-31",
            expected: "REJECTED_FIELD:dueOn",
          },
          {
            ...base,
            rowId: "ok-after",
            businessId: `${run}-ok-after`,
            expected: "CREATED",
          },
        ],
        [],
      );
      const rows = await readInputRows(input);
      expect(rows.map((row) => row.issuedOn)).toContain("31/02/2026");

      const bot = new InvoiceBatchBot(page, {
        baseUrl: BASE_URL,
        rut: creator.credentials.rut,
        password: creator.credentials.password,
      });
      const outcomes = await bot.run(rows.map(toBotRow));
      expect(bot.abort, "an invalid date must not crash the batch").toBe(
        undefined,
      );
      expect(
        outcomes.map((outcome) => [
          outcome.rowId,
          outcome.result,
          outcome.field,
        ]),
      ).toEqual([
        ["ok", "CREATED", ""],
        ["bad-issued", "REJECTED_FIELD", "issuedOn"],
        ["bad-due", "REJECTED_FIELD", "dueOn"],
        ["ok-after", "CREATED", ""],
      ]);
    } finally {
      await s.dispose();
    }
  });
});
