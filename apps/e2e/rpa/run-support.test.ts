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
import { after, mock, test } from "node:test";

import { InputError } from "./args.ts";
import {
  readOutputTable,
  writeOutput,
  type InputRow,
  type RowOutcome,
} from "./excel.ts";
import {
  createSignalState,
  exitCodeFor,
  finalExitCode,
  launchOptions,
  persistOutcomes,
  resultsJsonPath,
} from "./run-support.ts";

const dir = mkdtempSync(join(tmpdir(), "rpa-run-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const outcome = (rowId: string): RowOutcome => ({
  rowId,
  result: "CREATED",
  invoiceId: "inv-1",
  errorKind: "",
  errorStatus: "",
  errorCode: "",
  field: "",
  message: "",
  attempts: 1,
  finishedAt: "2026-11-19T00:00:00.000Z",
});

test("exit codes: 0 finished, 1 aborted or crashed, 129/130/143 interrupted", () => {
  assert.equal(exitCodeFor({}), 0);
  assert.equal(exitCodeFor({ abort: { kind: "crash" } }), 1);
  assert.equal(exitCodeFor({ abort: { kind: "credentials" } }), 1);
  assert.equal(exitCodeFor({ writeFailed: true }), 1);
  assert.equal(
    exitCodeFor({ abort: { kind: "interrupted" }, signal: "SIGINT" }),
    130,
  );
  assert.equal(
    exitCodeFor({ abort: { kind: "interrupted" }, signal: "SIGTERM" }),
    143,
  );
  assert.equal(
    exitCodeFor({ abort: { kind: "interrupted" }, signal: "SIGHUP" }),
    129,
  );
  // A crash that raced a signal is still reported as the signal.
  assert.equal(
    exitCodeFor({ abort: { kind: "crash" }, signal: "SIGTERM" }),
    143,
  );
});

test("a signal received at any point is the exit code, even after the batch finished", () => {
  // Policy change (CR-411): a signal that arrived once every row was done used
  // to exit 0. The operator asked the process to stop, so the supervisor must
  // see 128+N whatever the batch state was (the output is written anyway).
  assert.equal(exitCodeFor({ signal: "SIGINT" }), 130);
  assert.equal(exitCodeFor({ signal: "SIGTERM" }), 143);
  assert.equal(exitCodeFor({ signal: "SIGHUP" }), 129);
  assert.equal(exitCodeFor({ signal: "SIGINT", writeFailed: true }), 130);
});

test("the results fallback sits next to the output workbook", () => {
  assert.equal(resultsJsonPath("/x/out.xlsx"), "/x/out.xlsx.results.json");
});

test("a workbook that writes is the whole story", async () => {
  const written: string[] = [];
  const result = await persistOutcomes({
    output: join(dir, "ok.xlsx"),
    outcomes: [outcome("1")],
    writeWorkbook: async (path) => {
      written.push(path);
    },
    stderr: () => assert.fail("nothing to report"),
  });
  assert.deepEqual(result, { kind: "workbook" });
  assert.deepEqual(written, [join(dir, "ok.xlsx")]);
});

test("a failed workbook write dumps the outcomes next to it", async () => {
  const output = join(dir, "bad.xlsx");
  const lines: string[] = [];
  const result = await persistOutcomes({
    output,
    outcomes: [outcome("1"), outcome("2")],
    writeWorkbook: async () => {
      throw new Error("EACCES");
    },
    stderr: (line) => lines.push(line),
  });
  assert.equal(result.kind, "json");
  const saved = JSON.parse(readFileSync(`${output}.results.json`, "utf8"));
  assert.deepEqual(
    saved.map((item: RowOutcome) => item.rowId),
    ["1", "2"],
  );
  assert.match(lines.join("\n"), /EACCES/);
  assert.match(lines.join("\n"), /bad\.xlsx\.results\.json/);
});

test("when the JSON can not be written either, the outcomes go to stderr", async () => {
  const lines: string[] = [];
  const result = await persistOutcomes({
    output: join(dir, "missing-dir", "x.xlsx"),
    outcomes: [outcome("7")],
    writeWorkbook: async () => {
      throw new Error("disk full");
    },
    stderr: (line) => lines.push(line),
  });
  assert.equal(result.kind, "stderr");
  assert.match(lines.join("\n"), /"rowId": "7"/);
});

test("the results fallback is atomic: a failed write keeps the previous JSON", async () => {
  const output = join(dir, "atomic.xlsx");
  const path = resultsJsonPath(output);
  writeFileSync(path, "previous");
  const lines: string[] = [];
  const result = await persistOutcomes({
    output,
    outcomes: [outcome("1")],
    writeWorkbook: async () => {
      throw new Error("EACCES");
    },
    writeJson: (temp) => {
      writeFileSync(temp, "trunc");
      throw new Error("killed");
    },
    stderr: (line) => lines.push(line),
  });
  assert.equal(result.kind, "stderr");
  assert.equal(readFileSync(path, "utf8"), "previous");
  assert.deepEqual(
    readdirSync(dir)
      .filter((name) => name.startsWith("atomic.xlsx.results"))
      .sort(),
    ["atomic.xlsx.results.json"],
  );
});

test("the browser never installs its own signal handlers (CR-408 / CR-426)", () => {
  for (const headed of [true, false]) {
    const options = launchOptions({ headed });
    assert.equal(options.handleSIGINT, false);
    assert.equal(options.handleSIGTERM, false);
    assert.equal(options.handleSIGHUP, false);
    assert.equal(options.headless, !headed);
  }
});

function signalHarness() {
  const events: string[] = [];
  const state = createSignalState({
    abort: () => events.push("abort"),
    exit: (code) => events.push(`exit ${code}`),
    cleanup: () => events.push("cleanup"),
    stderr: (line) => events.push(`stderr ${line.split(":")[0]}`),
  });
  return { state, events };
}

test("the first signal aborts once and is remembered", () => {
  const { state, events } = signalHarness();
  assert.equal(state.signal, undefined);
  state.handle("SIGTERM");
  assert.equal(state.signal, "SIGTERM");
  assert.deepEqual(events, ["stderr SIGTERM", "abort"]);
});

test("a second signal outside a write cleans up and exits with the first code", () => {
  const { state, events } = signalHarness();
  state.handle("SIGINT");
  state.handle("SIGTERM");
  assert.deepEqual(events.slice(2), [
    "stderr Second signal",
    "cleanup",
    "exit 130",
  ]);
});

test("a second signal during an atomic write waits for it, then exits (CR-430)", async () => {
  const { state, events } = signalHarness();
  const output = join(dir, "second-signal.xlsx");
  state.handle("SIGINT");
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  const end = state.beginWrite();
  const persisting = persistOutcomes({
    output,
    outcomes: [outcome("1")],
    writeWorkbook: async (path) => {
      await gate;
      writeFileSync(path, "complete");
    },
    stderr: () => undefined,
  }).finally(end);
  state.handle("SIGTERM"); // a third signal would force the quit (CR-434)
  assert.equal(
    events.some((event) => event.startsWith("exit")),
    false,
  );
  release();
  await persisting;
  assert.deepEqual(events.slice(-2), ["cleanup", "exit 130"]);
  assert.equal(events.filter((event) => event.startsWith("exit")).length, 1);
  // The write finished: the output is complete and no temp file is left.
  assert.equal(readFileSync(output, "utf8"), "complete");
  assert.deepEqual(
    readdirSync(dir).filter((name) =>
      name.startsWith("second-signal.xlsx.tmp-"),
    ),
    [],
  );
});

test("a signal after the batch is done only records the exit code (CR-429)", () => {
  const { state, events } = signalHarness();
  // Handlers stay installed after the batch: the first signal never exits.
  state.handle("SIGHUP");
  assert.equal(
    events.some((event) => event.startsWith("exit")),
    false,
  );
  assert.equal(exitCodeFor({ signal: state.signal }), 129);
});

test("a signal before the input is read still yields a full NOT_PROCESSED output (CR-428)", async () => {
  const row = (rowId: string): InputRow => ({
    rowId,
    organization: "Org",
    group: "",
    businessId: `B-${rowId}`,
    supplierName: "Proveedor",
    amountPesos: "100",
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    status: "",
    expected: "CREATED",
    fault: "",
    note: "",
  });
  const rows = [row("a"), row("b")];
  const output = join(dir, "early.xlsx");
  const result = await persistOutcomes({
    output,
    outcomes: [],
    writeWorkbook: (path) => writeOutput(path, rows, []),
    stderr: () => assert.fail("nothing to report"),
  });
  assert.equal(result.kind, "workbook");
  const table = await readOutputTable(output);
  assert.deepEqual(
    table.rows.map((r) => r.result),
    ["NOT_PROCESSED", "NOT_PROCESSED"],
  );
  assert.equal(exitCodeFor({ signal: "SIGINT" }), 130);
});

test("finalExitCode: a received signal always wins (CR-433)", () => {
  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    assert.equal(finalExitCode({ signal, result: 0 }), code);
    assert.equal(finalExitCode({ signal, result: 1 }), code);
    assert.equal(finalExitCode({ signal, result: 2 }), code);
    assert.equal(
      finalExitCode({ signal, result: undefined, error: new InputError("x") }),
      code,
    );
    assert.equal(
      finalExitCode({ signal, result: undefined, error: new Error("boom") }),
      code,
    );
  }
});

test("finalExitCode: without a signal the result, InputError (2) or a crash (1) decide", () => {
  assert.equal(finalExitCode({ signal: undefined, result: 0 }), 0);
  assert.equal(finalExitCode({ signal: undefined, result: 1 }), 1);
  assert.equal(finalExitCode({ signal: undefined, result: 2 }), 2);
  assert.equal(
    finalExitCode({
      signal: undefined,
      result: undefined,
      error: new InputError("bad"),
    }),
    2,
  );
  assert.equal(
    finalExitCode({
      signal: undefined,
      result: undefined,
      error: new Error("boom"),
    }),
    1,
  );
  assert.equal(
    finalExitCode({ signal: undefined, result: undefined, error: "str" }),
    1,
  );
});

test("signal state and final code: a signal after the batch result still wins (CR-433)", () => {
  const { state } = signalHarness();
  const batchResult = 0;
  state.handle("SIGTERM"); // lands after main computed its result
  assert.equal(
    finalExitCode({ signal: state.signal, result: batchResult }),
    143,
  );
});

test("signal state and final code: a signal during the read then an InputError exits 128+N (CR-433)", () => {
  const { state } = signalHarness();
  state.handle("SIGINT");
  assert.equal(
    finalExitCode({
      signal: state.signal,
      result: undefined,
      error: new InputError("missing columns"),
    }),
    130,
  );
});

function timerHarness(forceQuitMs?: number) {
  const events: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const state = createSignalState({
    abort: () => events.push("abort"),
    exit: (code) => events.push(`exit ${code}`),
    cleanup: () => events.push("cleanup"),
    stderr: (line) => events.push(`stderr ${line.split(":")[0]}`),
    startTimer: (fn, ms) => timers.push({ fn, ms }),
    ...(forceQuitMs === undefined ? {} : { forceQuitMs }),
  });
  return { state, events, timers };
}

test("a third signal during a write forces an immediate quit (CR-434)", () => {
  const { state, events } = timerHarness();
  state.handle("SIGINT");
  state.beginWrite();
  state.handle("SIGTERM"); // waits
  assert.equal(
    events.some((event) => event.startsWith("exit")),
    false,
  );
  state.handle("SIGHUP"); // forced
  assert.deepEqual(events.slice(-2), ["cleanup", "exit 130"]);
});

test("the second signal arms a 10 s cap that forces the quit if the write hangs (CR-434)", () => {
  const { state, events, timers } = timerHarness();
  state.handle("SIGTERM");
  assert.equal(timers.length, 0);
  state.beginWrite();
  state.handle("SIGINT");
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 10_000);
  timers[0]?.fn();
  assert.deepEqual(events.slice(-2), ["cleanup", "exit 143"]);
});

test("the cap is injectable and a write that ends first exits once, ignoring the timer (CR-434)", () => {
  const { state, events, timers } = timerHarness(250);
  state.handle("SIGINT");
  const end = state.beginWrite();
  state.handle("SIGTERM");
  assert.equal(timers[0]?.ms, 250);
  end();
  timers[0]?.fn();
  assert.equal(events.filter((event) => event.startsWith("exit")).length, 1);
  assert.equal(events.filter((event) => event === "cleanup").length, 1);
});

test("the default timer is unref'd so it never keeps the process alive (CR-434)", () => {
  let unrefCalls = 0;
  const handle = {
    unref() {
      unrefCalls += 1;
      return handle;
    },
  };
  const fake = mock.method(globalThis, "setTimeout", (() => handle) as never);
  try {
    const state = createSignalState({
      abort: () => undefined,
      exit: () => undefined,
      cleanup: () => undefined,
      stderr: () => undefined,
      forceQuitMs: 60_000,
    });
    state.handle("SIGINT");
    state.beginWrite();
    state.handle("SIGTERM"); // arms the default timer
    assert.equal(fake.mock.callCount(), 1);
    assert.equal(fake.mock.calls[0]?.arguments[1], 60_000);
    assert.equal(unrefCalls, 1);
  } finally {
    fake.mock.restore();
  }
});

test("a cleanup that throws still exits with 128+N and warns on stderr (CR-441)", () => {
  const events: string[] = [];
  const state = createSignalState({
    abort: () => events.push("abort"),
    exit: (code) => events.push(`exit ${code}`),
    cleanup: () => {
      throw new Error("EBUSY: resource busy");
    },
    stderr: (line) => events.push(`stderr ${line}`),
  });
  state.handle("SIGINT");
  state.handle("SIGINT");
  assert.equal(events.at(-1), "exit 130");
  assert.ok(
    events.some((event) => /EBUSY/.test(event) && /cleanup/i.test(event)),
  );
});
