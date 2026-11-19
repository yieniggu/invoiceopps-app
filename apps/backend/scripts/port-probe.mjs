import { execFile } from "node:child_process";
import { connect, createServer } from "node:net";

// BEST-EFFORT guard, not a lock. A bind probe on 127.0.0.1 can succeed even
// when something listens on the wildcard address (SO_REUSEADDR semantics on
// macOS), so a TCP connect to 127.0.0.1:port is tried first: a connection that
// succeeds means the port is in use. Both checks are still a time-of-check /
// time-of-use race: the port can be taken right after this returns, and then
// the server itself fails to start with EADDRINUSE.

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
export function isAcceptingConnections(port, timeoutMs = 1000) {
  return new Promise((resolveProbe) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (inUse) => {
      socket.destroy();
      resolveProbe(inUse);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function bindFree(port) {
  return new Promise((resolveBind, rejectBind) => {
    const probe = createServer();
    probe.once("error", rejectBind);
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolveBind()));
  });
}

/**
 * PIDs listening on the port, best effort (`lsof`, POSIX): [] when lsof is
 * missing, fails or finds nothing. `run` is injectable for tests.
 */
export function listPortHolders(
  port,
  run = (cmd, args) =>
    new Promise((resolveRun) =>
      execFile(cmd, args, { timeout: 3000 }, (error, stdout) =>
        resolveRun(error ? "" : String(stdout)),
      ),
    ),
) {
  return Promise.resolve(
    run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]),
  ).then(
    (out) => [
      ...new Set(
        String(out)
          .split(/\s+/)
          .filter((p) => /^\d+$/.test(p)),
      ),
    ],
    () => [],
  );
}

/** The refusal text, with the holders and the exact cleanup command if known. */
export function portInUseMessage(port, code, pids) {
  const base = `port ${port} is already in use (${code}): a previous E2E backend was not stopped; stop it or set E2E_REUSE_SERVERS`;
  if (pids.length === 0) return base;
  return `${base}. Held by PID ${pids.join(", ")}; if it is a leftover E2E backend: kill ${pids.join(" ")}`;
}

// A server left over from an aborted run would keep the port (and its pool of
// connections to the database about to be recreated): refuse with a clear
// message instead of failing later inside the server.
export async function assertPortFree(
  port,
  { listHolders = listPortHolders } = {},
) {
  const inUse = async (code) =>
    new Error(portInUseMessage(port, code, await listHolders(port)));
  if (await isAcceptingConnections(port)) throw await inUse("connect");
  try {
    await bindFree(port);
  } catch (error) {
    throw await inUse(error.code);
  }
}
