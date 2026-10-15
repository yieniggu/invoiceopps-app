import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runIntegrationGate } from "./test-integration.mjs";

export function assertOwnedListener(output, pid, port) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65535
  )
    throw new Error("Invalid Anvil ownership identity");
  const lines = output.trim().split("\n").slice(1).filter(Boolean);
  if (
    lines.length !== 1 ||
    !lines[0].includes(` ${pid} `) ||
    !lines[0].endsWith(`TCP 127.0.0.1:${port} (LISTEN)`)
  )
    throw new Error("Anvil listener ownership or loopback binding mismatch");
}

const smokeSteps = new Set([
  "full-cli-anchor-child",
  "full-cli-anchor-output",
  "anchor-assertions",
  "full-cli-reconcile-child",
  "full-cli-reconcile-output",
  "reconcile-assertions",
  "guard-assertions",
  "smoke-assertions",
]);
const smokePhases = new Set([
  "setup",
  "anchor",
  "reconcile",
  "full-cli-reconcile",
  "guards",
]);
const cliPhases = new Set(["input", "database", "execute", "cleanup"]);
const cliOperations = new Set(["anchor", "reconcile", "command"]);
const cliReasons = new Set([
  "usage",
  "authentication",
  "configuration",
  "database",
  "data",
  "operation",
  "cleanup",
]);
const rpcMethods = new Set([
  "eth_chainId",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_getBlockByNumber",
  "eth_call",
  "eth_sendRawTransaction",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_blockNumber",
  "eth_getLogs",
]);
const spawnCodes = new Set([
  "EACCES",
  "EINVAL",
  "EMFILE",
  "ENOENT",
  "ENOMEM",
  "ENOTDIR",
  "EPIPE",
  "ETIMEDOUT",
]);
const signals = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGTERM",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUSR1",
  "SIGUSR2",
]);

const CHILD_OUTPUT_LIMIT = 64_000;
const CHILD_TEARDOWN_MS = 5_000;
const ownedProcessGroupStatusCodes = new Set([
  "EACCES",
  "EINVAL",
  "EPERM",
  "ESRCH",
  "ERR_INVALID_ARG_TYPE",
]);

function ownedProcessGroupStatusError(error, phase) {
  const code =
    typeof error?.code === "string" &&
    ownedProcessGroupStatusCodes.has(error.code)
      ? error.code
      : "UNKNOWN";
  return new Error(
    `Owned child process group status unavailable; phase=${phase}; errno=${code}`,
  );
}

function signalOwnedProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

async function waitForOwnedProcessGroup(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw ownedProcessGroupStatusError(error, "probe");
    }
    await delay(25);
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw ownedProcessGroupStatusError(error, "final-probe");
  }
}

async function terminateOwnedProcessGroup(pid) {
  signalOwnedProcessGroup(pid, "SIGTERM");
  if (await waitForOwnedProcessGroup(pid, 1_000)) return true;
  signalOwnedProcessGroup(pid, "SIGKILL");
  return waitForOwnedProcessGroup(pid, CHILD_TEARDOWN_MS - 1_000);
}

export async function runOwnedChild(command, args, options) {
  const timeoutMs = options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes ?? CHILD_OUTPUT_LIMIT;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0
  )
    throw new Error("Invalid owned child limits");

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: [], stderr: [], bytes: 0 };
  let outputLimitExceeded = false;
  let timedOut = false;
  let spawnCode;
  const append = (target, chunk) => {
    if (outputLimitExceeded) return;
    const data = Buffer.from(chunk);
    output.bytes += data.length;
    if (output.bytes > maxOutputBytes) {
      outputLimitExceeded = true;
      return;
    }
    target.push(data);
  };
  child.stdout.on("data", (chunk) => append(output.stdout, chunk));
  child.stderr.on("data", (chunk) => append(output.stderr, chunk));
  child.once("error", (error) => {
    spawnCode = error && "code" in error ? error.code : undefined;
  });

  let closeResult;
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => {
      closeResult = { status, signal };
      resolve(closeResult);
    });
  });
  const trigger = new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve("timeout");
    }, timeoutMs);
    const checkOutput = () => {
      if (outputLimitExceeded) {
        clearTimeout(timer);
        resolve("output-limit");
      }
    };
    child.stdout.on("data", checkOutput);
    child.stderr.on("data", checkOutput);
    closed.then(() => {
      clearTimeout(timer);
      resolve("closed");
    });
  });

  const outcome = await trigger;
  let cleanupVerified = true;
  if (outcome === "timeout" || outcome === "output-limit") {
    cleanupVerified = child.pid
      ? await terminateOwnedProcessGroup(child.pid)
      : true;
  }
  if (!closeResult) {
    await Promise.race([
      closed,
      delay(CHILD_TEARDOWN_MS).then(() => {
        throw new Error("Owned child process did not close after teardown");
      }),
    ]);
  }
  if (!cleanupVerified)
    throw new Error("Owned child process group teardown was not verified");

  return {
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
    status: closeResult.status,
    signal: closeResult.signal,
    spawnCode,
    timedOut,
    outputLimitExceeded,
  };
}

export function formatSmokeFailure(details = {}) {
  const step = smokeSteps.has(details.step) ? details.step : "smoke-assertions";
  const cause =
    details.cause === "child-timeout"
      ? "child-timeout"
      : details.cause === "child-spawn-error"
        ? "child-spawn-error"
        : details.cause === "child-exit-nonzero"
          ? "child-exit-nonzero"
          : details.cause === "assertion-failed"
            ? "assertion-failed"
            : "child-process-failed";
  const status = Number.isSafeInteger(details.status)
    ? String(details.status)
    : "none";
  const signal = signals.has(details.signal) ? details.signal : "none";
  const spawnCode = spawnCodes.has(details.spawnCode)
    ? details.spawnCode
    : "none";
  const cliPhase = cliPhases.has(details.cliPhase) ? details.cliPhase : "none";
  const cliOperation = cliOperations.has(details.cliOperation)
    ? details.cliOperation
    : "none";
  const cliReason = cliReasons.has(details.cliReason)
    ? details.cliReason
    : "none";
  const phase = smokePhases.has(details.phase) ? details.phase : "setup";
  const method = rpcMethods.has(details.method) ? details.method : "unknown";
  return `SMOKE_FAILURE step=${step} cause=${cause} status=${status} signal=${signal} spawn_code=${spawnCode} cli_phase=${cliPhase} cli_operation=${cliOperation} cli_reason=${cliReason} phase=${phase} method=${method}`;
}

export function reportSmokeFailure(
  error,
  details = {},
  output = console.error,
) {
  output(formatSmokeFailure(details));
  return error;
}

export function checkOwnedListener(pid, port) {
  const result = spawnSync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN"],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 8192,
    },
  );
  if (result.error || result.status !== 0 || result.stderr)
    throw new Error("Owned Anvil listener unavailable");
  assertOwnedListener(result.stdout, pid, port);
}

export async function stopOwnedChild(child) {
  if (!child.pid) return false;
  let observedExit = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => {
    observedExit = true;
    resolveExit();
  };
  const hasExited = () =>
    observedExit || child.exitCode !== null || child.signalCode !== null;
  // Subscribe before signaling: a child can emit exit synchronously at kill().
  child.once("exit", onExit);
  child.once("close", onExit);
  async function waitForExit() {
    if (hasExited()) return true;
    let timer;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    if (hasExited()) return true;
    if (!child.killed) child.kill("SIGTERM");
    if (await waitForExit()) return true;
    if (!hasExited()) child.kill("SIGKILL");
    return await waitForExit();
  } finally {
    child.removeListener("exit", onExit);
    child.removeListener("close", onExit);
  }
}

async function vacantPort() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No ephemeral port");
    return address.port;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

let currentPhase = "startup";

const smokeFailurePattern =
  /SMOKE_FAILURE step=[a-z0-9-]+ cause=(?:child-timeout|child-spawn-error|child-exit-nonzero|assertion-failed|child-process-failed) status=(?:-?\d+|none) signal=(?:SIG[A-Z]+|none) spawn_code=(?:E[A-Z]+|none) cli_phase=(?:input|database|execute|cleanup|none) cli_operation=(?:anchor|reconcile|command|none) cli_reason=(?:usage|authentication|configuration|database|data|operation|cleanup|none) phase=[a-z0-9-]+ method=(?:eth_[A-Za-z0-9]+|unknown)/;

function safeFailureCause(error) {
  if (!(error instanceof Error)) return "unclassified";
  const smokeFailure = error.message.match(smokeFailurePattern);
  if (smokeFailure) return smokeFailure[0].match(/ cause=([a-z0-9-]+)/)[1];
  const commandFailure = error.message.match(
    /^[A-Za-z0-9 -]+ failed or timed out; cause=(timeout|spawn-failed|exit-\d+|process-failed); phase=[a-z0-9-]+(?:; SMOKE_FAILURE phase=[a-z0-9-]+ method=eth_[A-Za-z0-9]+)?$/,
  );
  if (commandFailure) return commandFailure[1];
  const causes = new Map([
    ["Isolated PostgreSQL readiness timed out", "postgres-readiness-timeout"],
    ["Loopback port verification failed", "loopback-port-mismatch"],
    [
      "Migration ledger name, checksum or status mismatch",
      "migration-ledger-mismatch",
    ],
    [
      "Expected exactly eight immutable baseline migrations",
      "baseline-migration-count-mismatch",
    ],
    ["Baseline migration copy differs from source", "baseline-copy-mismatch"],
    ["New container ownership unavailable", "container-ownership-unavailable"],
    [
      "Owned container still exists after cleanup",
      "container-cleanup-unverified",
    ],
    ["Owned Anvil listener absence not verified", "anvil-cleanup-unverified"],
  ]);
  return causes.get(error.message) ?? "gate-assertion-failed";
}

async function main() {
  currentPhase = "preflight";
  if (
    process.argv.length !== 2 ||
    [
      "DATABASE_URL",
      "TEST_DATABASE_URL",
      "APP10_TEST_NAMESPACE",
      "APP10_LEGACY_EVENT_ID",
      "APP11_OWN_ANVIL_PID",
      "APP11_OWN_ANVIL_PORT",
    ].some((key) => process.env[key])
  )
    throw new Error(
      "Smoke rejects arguments and preconfigured database or node targets",
    );
  const port = await vacantPort();
  currentPhase = "anvil-startup";
  const child = spawn(
    "anvil",
    [
      "--quiet",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      "31337",
    ],
    {
      stdio: "ignore",
      env: Object.fromEntries(
        ["PATH", "HOME", "TMPDIR"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
    },
  );
  let interrupted = false;
  let cleanupFailure;
  let runFailure;
  const onSignal = () => {
    interrupted = true;
    if (
      child.pid &&
      child.exitCode === null &&
      child.signalCode === null &&
      !child.killed
    )
      child.kill("SIGTERM");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (!child.pid) throw new Error("Anvil did not start");
    currentPhase = "anvil-listener-ownership";
    const deadline = Date.now() + 10_000;
    while (true) {
      if (interrupted || child.exitCode !== null || child.signalCode !== null)
        throw new Error("Anvil exited before ownership verification");
      try {
        checkOwnedListener(child.pid, port);
        break;
      } catch {
        if (Date.now() >= deadline)
          throw new Error("Anvil listener preflight timed out or collided");
        await delay(100);
      }
    }
    console.info("stage: own loopback Anvil PID and listener verified");
    currentPhase = "integration-gate-preflight";
    await runIntegrationGate({
      ownedAnvil: { pid: child.pid, port },
      log(message) {
        const stage = message.match(/^stage: ([a-z0-9-]+)(?: \d+ passed)?$/i);
        if (stage) currentPhase = stage[1].toLowerCase();
        console.info(message);
      },
    });
    if (interrupted) throw new Error("Smoke interrupted");
  } catch (error) {
    runFailure = error;
    const smokeDiagnostic =
      error instanceof Error
        ? error.message.match(smokeFailurePattern)?.[0]
        : undefined;
    const smokeStep = smokeDiagnostic?.match(/ step=([a-z0-9-]+)/)?.[1];
    const commandPhase =
      error instanceof Error
        ? error.message.match(
            /; cause=(?:timeout|spawn-failed|exit-\d+|process-failed); phase=([a-z0-9-]+)/,
          )?.[1]
        : undefined;
    runFailure.phase = smokeStep
      ? `owned-anvil-smoke-${smokeStep}`
      : (commandPhase ?? currentPhase);
    runFailure.safeCause = safeFailureCause(error);
    runFailure.safeDiagnostic = smokeDiagnostic;
  } finally {
    currentPhase = "anvil-cleanup";
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (child.pid && !(await stopOwnedChild(child)))
      cleanupFailure = new Error("Owned Anvil process did not exit");
    if (child.pid) {
      const result = spawnSync(
        "lsof",
        ["-nP", "-a", "-p", String(child.pid), `-iTCP:${port}`, "-sTCP:LISTEN"],
        { encoding: "utf8", timeout: 3000, maxBuffer: 8192 },
      );
      if (result.status !== 1 || result.stdout.trim())
        cleanupFailure = new Error("Owned Anvil listener absence not verified");
      else if (!cleanupFailure)
        console.info("cleanup: owned Anvil process exited and listener absent");
    }
  }
  if (cleanupFailure)
    throw new Error(
      "OWN_SMOKE_FAILURE phase=anvil-cleanup cause=cleanup-unverified",
    );
  if (runFailure)
    throw new Error(
      `OWN_SMOKE_FAILURE phase=${runFailure.phase ?? "integration-gate"} cause=${runFailure.safeCause ?? "unclassified"}${runFailure.safeDiagnostic ? `; ${runFailure.safeDiagnostic}` : ""}`,
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    const safe =
      error instanceof Error
        ? error.message.match(
            /^OWN_SMOKE_FAILURE phase=[a-z0-9-]+ cause=[a-z0-9-]+(?:; SMOKE_FAILURE step=[a-z0-9-]+ cause=(?:child-timeout|child-spawn-error|child-exit-nonzero|assertion-failed|child-process-failed) status=(?:-?\d+|none) signal=(?:SIG[A-Z]+|none) spawn_code=(?:E[A-Z]+|none) cli_phase=(?:input|database|execute|cleanup|none) cli_operation=(?:anchor|reconcile|command|none) cli_reason=(?:usage|authentication|configuration|database|data|operation|cleanup|none) phase=[a-z0-9-]+ method=(?:eth_[A-Za-z0-9]+|unknown))?$/,
          )?.[0]
        : null;
    console.error(
      `owned smoke failed: ${safe ?? "OWN_SMOKE_FAILURE phase=preflight cause=precondition-rejected"}`,
    );
    process.exitCode = 1;
  });
}
