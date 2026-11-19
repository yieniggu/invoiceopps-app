import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { removeActiveTemps, writeAtomically } from "./atomic.ts";

const dir = mkdtempSync(join(tmpdir(), "rpa-atomic-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a successful write replaces the file and leaves no temp file", async () => {
  const path = join(dir, "ok.txt");
  writeFileSync(path, "old");
  await writeAtomically(path, (temp) => writeFileSync(temp, "new"));
  assert.equal(readFileSync(path, "utf8"), "new");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("a write that fails halfway keeps the previous file and removes the temp", async () => {
  const path = join(dir, "kept.txt");
  writeFileSync(path, "previous");
  await assert.rejects(
    writeAtomically(path, (temp) => {
      writeFileSync(temp, "trunc");
      throw new Error("disk full");
    }),
    /disk full/,
  );
  assert.equal(readFileSync(path, "utf8"), "previous");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith("kept.txt.tmp-")),
    [],
  );
});

test("the temp file lives next to the target, so the final path is never partial", async () => {
  const path = join(dir, "next.txt");
  let seen = "";
  await writeAtomically(path, (temp) => {
    seen = temp;
    writeFileSync(temp, "x");
    assert.throws(() => readFileSync(path), /ENOENT/);
  });
  assert.equal(seen.startsWith(`${path}.tmp-${process.pid}-`), true);
  assert.match(
    seen.slice(`${path}.tmp-${process.pid}-`.length),
    /^[0-9a-f]{16,}$/,
  );
  assert.equal(readFileSync(path, "utf8"), "x");
});

test("a symlinked output is written through: the link stays, its target is updated (CR-432)", async () => {
  const real = join(dir, "real-target.txt");
  const link = join(dir, "link.txt");
  writeFileSync(real, "old");
  symlinkSync(real, link);
  await writeAtomically(link, (temp) => writeFileSync(temp, "new"));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), "new");
  assert.equal(readFileSync(link, "utf8"), "new");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("a dangling symlink is written through to where it points", async () => {
  const real = join(dir, "dangling-target.txt");
  const link = join(dir, "dangling.txt");
  symlinkSync(real, link);
  await writeAtomically(link, (temp) => writeFileSync(temp, "made"));
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), "made");
});

function busy(code: string) {
  return Object.assign(new Error(code), { code });
}

test("on win32 a rename that fails with EPERM/EBUSY is retried (CR-431)", async () => {
  const path = join(dir, "win.txt");
  let calls = 0;
  const delays: number[] = [];
  await writeAtomically(path, (temp) => writeFileSync(temp, "w"), {
    platform: "win32",
    rename: (from, to) => {
      calls += 1;
      if (calls < 3) throw busy(calls === 1 ? "EPERM" : "EBUSY");
      renameSync(from, to);
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
  assert.equal(readFileSync(path, "utf8"), "w");
});

test("on win32 the retries are bounded and the temp is removed on final failure", async () => {
  const path = join(dir, "win-fail.txt");
  let calls = 0;
  await assert.rejects(
    writeAtomically(path, (temp) => writeFileSync(temp, "w"), {
      platform: "win32",
      attempts: 4,
      rename: () => {
        calls += 1;
        throw busy("EPERM");
      },
      sleep: async () => undefined,
    }),
    /EPERM/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith("win-fail.txt.tmp-")),
    [],
  );
});

test("off win32 an EPERM is not retried and other errors never are", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["win32", "ENOSPC"],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      writeAtomically(
        join(dir, "once.txt"),
        (temp) => writeFileSync(temp, "w"),
        {
          platform,
          rename: () => {
            calls += 1;
            throw busy(code);
          },
          sleep: async () => undefined,
        },
      ),
      new RegExp(code),
    );
    assert.equal(calls, 1, `${platform} ${code}`);
  }
});

test("temp names differ across calls (CR-437)", async () => {
  const path = join(dir, "names.txt");
  const seen = new Set<string>();
  for (let i = 0; i < 20; i += 1) {
    await writeAtomically(path, (temp) => {
      seen.add(temp);
      writeFileSync(temp, "x");
    });
  }
  assert.equal(seen.size, 20);
});

test("a symlink planted at the old predictable temp name can not redirect the write (CR-437)", async () => {
  const path = join(dir, "planted.txt");
  const victim = join(dir, "victim.txt");
  writeFileSync(victim, "precious");
  symlinkSync(victim, `${path}.tmp-${process.pid}`);
  await writeAtomically(path, (temp) => writeFileSync(temp, "new"));
  assert.equal(readFileSync(victim, "utf8"), "precious");
  assert.equal(readFileSync(path, "utf8"), "new");
});

test("the temp file is created exclusively: a colliding name (even a symlink) is refused, not followed (CR-437)", async () => {
  const path = join(dir, "excl.txt");
  const victim = join(dir, "victim2.txt");
  writeFileSync(victim, "precious");
  symlinkSync(victim, `${path}.tmp-${process.pid}-fixed`);
  let wrote = false;
  await assert.rejects(
    writeAtomically(
      path,
      (temp) => {
        wrote = true;
        writeFileSync(temp, "evil");
      },
      { randomSuffix: () => "fixed" },
    ),
    /EEXIST/,
  );
  assert.equal(wrote, false);
  assert.equal(readFileSync(victim, "utf8"), "precious");
  // The foreign entry is not ours: it is left alone.
  assert.equal(
    lstatSync(`${path}.tmp-${process.pid}-fixed`).isSymbolicLink(),
    true,
  );
});

test("removeActiveTemps deletes the temp of a write in progress (CR-434)", async () => {
  const path = join(dir, "active.txt");
  let tempSeen = "";
  await assert.rejects(
    writeAtomically(path, async (temp) => {
      tempSeen = temp;
      writeFileSync(temp, "partial");
      removeActiveTemps();
      assert.throws(() => readFileSync(temp), /ENOENT/);
      throw new Error("aborted");
    }),
    /aborted/,
  );
  assert.equal(tempSeen.includes(".tmp-"), true);
});

test("removeActiveTemps continues past a failing entry and removes the rest (CR-441)", async () => {
  const a = join(dir, "multi-a.txt");
  const b = join(dir, "multi-b.txt");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const writes = [a, b].map((path) =>
    writeAtomically(path, async (temp) => {
      writeFileSync(temp, "x");
      await gate;
    }),
  );
  await new Promise((done) => setImmediate(done));
  const attempted: string[] = [];
  removeActiveTemps((temp) => {
    attempted.push(temp);
    if (attempted.length === 1) throw new Error("EBUSY");
    rmSync(temp, { force: true });
  });
  assert.equal(attempted.length, 2);
  // The failing first entry did not stop the second real removal (CR-452).
  assert.equal(existsSync(attempted[0]), true);
  assert.equal(existsSync(attempted[1]), false);
  release();
  const settled = await Promise.allSettled(writes);
  // The write whose temp was removed cannot rename it; the other completes.
  assert.deepEqual(settled.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
});

test("the write fails when the parent directory was swapped before the rename (CR-446)", async () => {
  const path = join(dir, "swap.txt");
  writeFileSync(path, "previous");
  let calls = 0;
  await assert.rejects(
    writeAtomically(path, (temp) => writeFileSync(temp, "new"), {
      realpath: () => (calls++ === 0 ? "/one" : "/two"),
    }),
    /changed/,
  );
  assert.equal(readFileSync(path, "utf8"), "previous");
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.startsWith("swap.txt.tmp-")),
    [],
  );
});
