import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Where a write to `path` must land: `path` itself, or, when it is a symlink,
 * the file it points to (so the link survives and its target is updated instead
 * of the link being replaced by a regular file). A dangling link is followed by
 * hand (bounded, to survive a loop) so the target is created where it points.
 */
export function resolveWriteTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 16; hops += 1) {
    let isLink = false;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return current; // does not exist: a plain new file
    }
    if (!isLink) return current;
    try {
      return realpathSync(current);
    } catch {
      // Dangling (or looping) link: step through it manually.
      current = resolve(dirname(current), readlinkSync(current));
    }
  }
  return current;
}

export interface AtomicOptions {
  /** Injectable for tests. */
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  /** Rename attempts on Windows (EPERM / EBUSY); default 5. */
  attempts?: number;
  /** Random part of the temp name; injectable for tests. */
  randomSuffix?: () => string;
  /** Canonical path of a directory; injectable for tests (CR-446). */
  realpath?: (path: string) => string;
}

/** Temp files of the writes in progress, so a forced quit can remove them. */
const activeTemps = new Set<string>();

/**
 * Removes the temp file of every write in progress (forced quit; best effort:
 * a failing entry, e.g. EBUSY / EPERM, never stops the rest, CR-441).
 * `remove` is injectable for tests.
 */
export function removeActiveTemps(
  remove: (temp: string) => void = (temp) => rmSync(temp, { force: true }),
): void {
  for (const temp of activeTemps) {
    try {
      remove(temp);
    } catch {
      // Best effort: keep removing the others.
    }
  }
  activeTemps.clear();
}

const RETRY_DELAY_MS = 40;

/**
 * Writes `path` all-or-nothing: `write` fills `<path>.tmp-<pid>-<random hex>` (same folder,
 * so the rename stays on one filesystem) and the rename publishes it. A failure
 * or a kill in the middle can leave a stray `.tmp-*` file, never a truncated
 * `path`; a previous `path` stays intact until the rename replaces it.
 *
 * A symlink `path` is written through (see `resolveWriteTarget`). Right before
 * the rename the canonical parent folder of the target is checked again and the
 * write fails if it changed. That is a cheap sanity check, not a defense: a
 * local attacker who can swap a symlink between `resolveWriteTarget` and the
 * rename is out of scope (local CLI, folders owned by the user, CR-446). On Windows
 * (best effort; the E2E stack targets macOS and Linux) a rename over a file
 * that is open elsewhere fails with EPERM/EBUSY: it is retried a few times
 * with a short delay before giving up.
 */
export async function writeAtomically(
  path: string,
  write: (tempPath: string) => Promise<void> | void,
  options: AtomicOptions = {},
): Promise<void> {
  const rename = options.rename ?? renameSync;
  const sleep =
    options.sleep ??
    ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const attempts =
    (options.platform ?? process.platform) === "win32"
      ? (options.attempts ?? 5)
      : 1;
  const target = resolveWriteTarget(path);
  const realpath = options.realpath ?? realpathSync;
  const parentBefore = realpath(dirname(target));
  const suffix = (
    options.randomSuffix ?? (() => randomBytes(8).toString("hex"))
  )();
  const temp = `${target}.tmp-${process.pid}-${suffix}`;
  // Exclusive create (O_EXCL, never follows a symlink): a planted entry at
  // this name makes the write fail instead of redirecting it (CR-437). Not
  // ours until this succeeds, so it is never removed on failure.
  closeSync(openSync(temp, "wx", 0o666));
  activeTemps.add(temp);
  try {
    await write(temp);
    if (realpath(dirname(target)) !== parentBefore) {
      throw new Error(`The folder of ${target} changed during the write`);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(temp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EBUSY";
        if (attempt >= attempts || !transient) throw error;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  } finally {
    activeTemps.delete(temp);
  }
}
