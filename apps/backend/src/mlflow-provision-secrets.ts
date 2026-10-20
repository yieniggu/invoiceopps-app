import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ProvisionError, RUT } from "./mlflow-provision-plan.js";

export async function loadProvisionSecrets(
  path: string,
  repoRoot: string,
  usernames: string[],
): Promise<Map<string, string>> {
  if (usernames.length === 0) return new Map();
  try {
    if (!isAbsolute(path) || path !== resolve(path) || usernames.length > 100)
      throw new Error("Unsafe file");
    const [canonical, repository] = await Promise.all([
      realpath(path),
      realpath(repoRoot),
    ]);
    const inside = relative(repository, canonical);
    if (
      canonical !== path ||
      inside === "" ||
      (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
    )
      throw new Error("Unsafe file");
    const expected = await lstat(path);
    if (!expected.isFile() || expected.isSymbolicLink())
      throw new Error("Unsafe file");
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let buffer: Buffer | undefined;
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o7177) !== 0 ||
        before.size > 65536 ||
        before.nlink !== 1 ||
        (await realpath(path)) !== canonical
      )
        throw new Error("Unsafe file");
      buffer = Buffer.alloc(65537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const after = await file.stat();
      if (
        bytesRead !== before.size ||
        bytesRead > 65536 ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("Changed file");
      const parsed: unknown = JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8"),
      );
      buffer.fill(0);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid file");
      const entries = Object.entries(parsed);
      if (
        entries.length > 100 ||
        entries.some(
          ([key, password]) =>
            !RUT.test(key) ||
            typeof password !== "string" ||
            password.length < 12 ||
            password.length > 256 ||
            /[\r\n\0]/.test(password),
        ) ||
        new Set(entries.map(([, value]) => value)).size !== entries.length
      )
        throw new Error("Invalid credentials");
      const available = new Map(entries as Array<[string, string]>);
      const result = new Map<string, string>();
      for (const username of usernames) {
        const password = available.get(username);
        if (!password) throw new Error("Missing credential");
        result.set(username, password);
      }
      return result;
    } finally {
      try {
        // Best-effort cleanup of mutable bytes, including read/parse failures.
        // Parsed JavaScript strings cannot be securely erased here.
        buffer?.fill(0);
      } finally {
        await file.close();
      }
    }
  } catch {
    throw new ProvisionError(503, "CREDENTIALS");
  }
}
