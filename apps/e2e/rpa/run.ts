import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import {
  DEFAULT_BASE_URL,
  InputError,
  assertDistinctPaths,
  checkBaseUrl,
  parseCliArgs,
  parsePlaceholders,
} from "./args.ts";
import { removeActiveTemps } from "./atomic.ts";
import { InvoiceBatchBot } from "./invoice-batch-bot.ts";
import {
  STOP_SIGNALS,
  createSignalState,
  exitCodeFor,
  finalExitCode,
  launchOptions,
  persistOutcomes,
  type StopSignal,
} from "./run-support.ts";
import {
  fillPlaceholders,
  readInputRows,
  toBotRow,
  writeOutput,
  type RowOutcome,
} from "./excel.ts";

const USAGE = `Usage: pnpm --filter @invoiceops/e2e rpa:run -- --input in.xlsx --output out.xlsx
  [--base-url ${DEFAULT_BASE_URL}] [--allow-remote] [--headed] [--set KEY=VALUE ...]
Credentials: RPA_RUT and RPA_PASSWORD. --set fills {{KEY}} placeholders of the
workbook in a temporary copy (the input file is never modified). The bot only
types credentials into localhost, 127.0.0.1 or [::1]; --allow-remote opens any
other https host.
Ctrl-C (SIGINT), SIGTERM or SIGHUP stops at once and does not wait for the row
being sent: that row is UNCERTAIN (it may or may not have been created), the
rows not started are NOT_PROCESSED, and the output workbook is written once the
input workbook was read (atomically: a rename of <output>.tmp-<pid>-<random>, never a
truncated file; a symlinked output is written through). A signal before the
input is read (during start-up, before the handlers exist) gets the default
action and nothing is written (nothing was sent). A second signal quits
without writing more, but waits for a write in progress to finish (a third
signal, or 10 s, forces the quit). A signal wins over every other exit code. If the
workbook can not be written, the outcomes go to <output>.results.json.
Exit code: 0 batch finished, 1 batch aborted, crashed or results not written as
a workbook, 2 input error (arguments, workbook, base URL), 129 / 130 / 143 a
SIGHUP / SIGINT / SIGTERM was received (whatever the state of the batch).`;

// The signal state of the running batch, so a signal that lands after `main`
// returned (handlers stay installed) still decides the exit code.
let lastState: { readonly signal: StopSignal | undefined } | undefined;

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  const rut = process.env.RPA_RUT;
  const password = process.env.RPA_PASSWORD;
  if (!rut || !password) {
    console.error("Set RPA_RUT and RPA_PASSWORD.\n\n" + USAGE);
    return 2;
  }
  const baseUrl = checkBaseUrl(args.baseUrl, args.allowRemote);
  assertDistinctPaths(args.input, args.output);
  const placeholders = parsePlaceholders(args.set);
  let input = resolve(args.input);
  if (!existsSync(input)) throw new InputError(`--input "${input}" not found`);
  const output = resolve(args.output);
  // Fail before the browser opens, not after the batch ran.
  try {
    mkdirSync(dirname(output), { recursive: true });
  } catch (error) {
    throw new InputError(
      `Can not create the output folder: ${(error as Error).message}`,
    );
  }
  console.log(`Using ${baseUrl}`);

  const stop = new AbortController();
  let scratch: string | undefined;
  const removeScratch = () => {
    const dir = scratch;
    scratch = undefined;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      // Best effort (EBUSY / EPERM): never block the exit (CR-441).
      console.error(`Could not remove ${dir}: ${(error as Error).message}`);
    }
  };
  // A second signal never interrupts an atomic write (it waits for it), and the
  // handlers stay installed until the process exits: a signal arriving after the
  // batch only records the exit code (see createSignalState).
  const state = createSignalState({
    abort: () => stop.abort(),
    exit: (code) => process.exit(code),
    cleanup: () => {
      removeScratch();
      removeActiveTemps();
    },
    stderr: (line) => console.error(line),
  });
  lastState = state;
  try {
    // Registered first thing inside the guarded region: a signal at any point
    // (even while the workbook is read) is answered. Never removed: they are
    // no-ops once the batch is done.
    // The handler itself records the exit code: a signal always wins, whenever
    // it lands (after `main` returned or before an InputError, CR-433).
    for (const name of STOP_SIGNALS)
      process.on(name, () => {
        state.handle(name);
        process.exitCode = exitCodeFor({ signal: state.signal });
      });
    if (Object.keys(placeholders).length > 0) {
      scratch = mkdtempSync(join(tmpdir(), "rpa-"));
      const filled = join(scratch, "input.xlsx");
      await fillPlaceholders(input, filled, placeholders);
      input = filled;
    }
    // Reads (and validates) the sheet before the browser opens.
    const rows = await readInputRows(input);
    // A signal that arrived before the browser: nothing was sent, every row
    // is NOT_PROCESSED and the browser never opens.
    let outcomes: RowOutcome[] = [];
    let abort: { kind: string } | undefined;
    if (!state.signal) {
      // launchOptions disables Playwright's own signal handlers: this CLI owns
      // the shutdown.
      const browser = await chromium.launch(
        launchOptions({ headed: args.headed }),
      );
      try {
        const context = await browser.newContext({ locale: "es-CL" });
        const page = await context.newPage();
        const bot = new InvoiceBatchBot(page, {
          baseUrl,
          rut,
          password,
          log: (line) => console.log(line),
          signal: stop.signal,
        });
        // `run` never throws on a failed batch: the output is always written.
        outcomes = await bot.run(rows.map(toBotRow));
        abort = bot.abort;
      } finally {
        await browser.close().catch(() => undefined);
      }
    }
    const endWrite = state.beginWrite();
    const persisted = await persistOutcomes({
      output,
      outcomes,
      writeWorkbook: (path) => writeOutput(path, rows, outcomes),
      stderr: (line) => console.error(line),
    }).finally(endWrite);
    if (persisted.kind === "workbook") console.log(`Wrote ${args.output}`);
    if (abort && abort.kind !== "interrupted")
      console.error(`Batch aborted (${abort.kind}); see the output workbook.`);
    return exitCodeFor({
      abort,
      signal: state.signal,
      writeFailed: persisted.kind !== "workbook",
    });
  } finally {
    removeScratch();
  }
}

main().then(
  (code) => {
    process.exitCode = finalExitCode({
      signal: lastState?.signal,
      result: code,
    });
  },
  (error: unknown) => {
    if (error instanceof InputError) {
      console.error(`${error.message}\n\n${USAGE}`);
    } else {
      console.error(error);
    }
    process.exitCode = finalExitCode({
      signal: lastState?.signal,
      result: undefined,
      error,
    });
  },
);
