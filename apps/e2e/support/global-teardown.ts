import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Specs that show a password the server generated. Playwright writes an
 * `error-context.md` (an ARIA snapshot of the page) next to a failure even when
 * `screenshot` and `trace` are off, and that snapshot can contain the one-time
 * password of the open dialog. Each failed test gets its own folder inside
 * `test-results/`, named after the spec file, so the snapshots of these specs
 * are recognised by that prefix and deleted when the run ends. The failure
 * message in the console stays; only the snapshot is dropped. See LOCAL_RUN.md.
 */
export const SECRET_SPECS = [
  "admin-users",
  "admin-wizard",
  "member-creation-secret",
] as const;

export function removeSecretErrorContexts(resultsDir: string) {
  if (!existsSync(resultsDir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !SECRET_SPECS.some((spec) => entry.name.startsWith(`${spec}-`))
    )
      continue;
    const file = resolve(resultsDir, entry.name, "error-context.md");
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  }
  return removed;
}

export default async function globalTeardown() {
  removeSecretErrorContexts(resolve(import.meta.dirname, "../test-results"));
}
