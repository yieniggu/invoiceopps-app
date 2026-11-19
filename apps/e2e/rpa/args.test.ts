import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_BASE_URL,
  InputError,
  assertDistinctPaths,
  checkBaseUrl,
  dropLeadingSeparator,
  parseCliArgs,
  parsePlaceholders,
} from "./args.ts";

test("a leading -- (what `pnpm run script -- args` forwards) is dropped", () => {
  assert.deepEqual(dropLeadingSeparator(["--", "--input", "a.xlsx"]), [
    "--input",
    "a.xlsx",
  ]);
});

test("arguments without a leading -- are untouched, and later -- stay", () => {
  assert.deepEqual(dropLeadingSeparator(["--input", "a.xlsx"]), [
    "--input",
    "a.xlsx",
  ]);
  assert.deepEqual(dropLeadingSeparator(["--input", "--", "x"]), [
    "--input",
    "--",
    "x",
  ]);
  assert.deepEqual(dropLeadingSeparator([]), []);
});

test("parseCliArgs reads the options once the separator is dropped", () => {
  const args = parseCliArgs(["--", "--input", "a.xlsx", "--output", "b.xlsx"]);
  assert.equal(args.input, "a.xlsx");
  assert.equal(args.output, "b.xlsx");
  assert.equal(args.baseUrl, DEFAULT_BASE_URL);
  assert.equal(args.headed, false);
  assert.equal(args.allowRemote, false);
  assert.equal(args.help, false);
  assert.deepEqual(args.set, []);
});

test("parseCliArgs reads flags, --base-url and repeated --set", () => {
  const args = parseCliArgs([
    "--input=a.xlsx",
    "--output=b.xlsx",
    "--base-url",
    "https://app.example.com",
    "--allow-remote",
    "--headed",
    "--set",
    "ORG=Mi org",
    "--set",
    "RUN=x=y",
  ]);
  assert.equal(args.baseUrl, "https://app.example.com");
  assert.equal(args.allowRemote, true);
  assert.equal(args.headed, true);
  assert.deepEqual(args.set, ["ORG=Mi org", "RUN=x=y"]);
});

test("parseCliArgs rejects an unknown option", () => {
  assert.throws(() => parseCliArgs(["--nope"]));
});

test("parsePlaceholders splits at the first = and refuses KEY-less entries", () => {
  assert.deepEqual(parsePlaceholders(["ORG=Mi org", "RUN=a=b", "EMPTY="]), {
    ORG: "Mi org",
    RUN: "a=b",
    EMPTY: "",
  });
  assert.throws(() => parsePlaceholders(["ORG"]), /KEY=VALUE/);
  assert.throws(() => parsePlaceholders(["=x"]), /KEY=VALUE/);
});

test("checkBaseUrl accepts the loopback hosts over http or https", () => {
  for (const url of [
    "http://127.0.0.1:5380",
    "http://localhost:5380/",
    "http://[::1]:5380",
    "https://localhost",
  ])
    assert.equal(checkBaseUrl(url, false), new URL(url).origin, url);
});

test("checkBaseUrl refuses a remote host unless --allow-remote, then needs https", () => {
  assert.throws(
    () => checkBaseUrl("https://app.example.com", false),
    /--allow-remote/,
  );
  assert.throws(
    () => checkBaseUrl("http://127.0.0.1.evil.com", false),
    /--allow-remote/,
  );
  assert.throws(() => checkBaseUrl("http://10.0.0.5", false), /--allow-remote/);
  assert.equal(
    checkBaseUrl("https://app.example.com/x", true),
    "https://app.example.com",
  );
  assert.throws(() => checkBaseUrl("http://app.example.com", true), /https/);
});

test("checkBaseUrl refuses malformed URLs, other schemes and embedded credentials", () => {
  assert.throws(() => checkBaseUrl("not a url", false), /not a valid URL/);
  assert.throws(() => checkBaseUrl("ftp://localhost", false), /http/);
  assert.throws(
    () => checkBaseUrl("http://user:pw@localhost:5380", false),
    /credentials/,
  );
});

test("assertDistinctPaths refuses an output that is the input", () => {
  assert.throws(
    () => assertDistinctPaths("./a.xlsx", "a.xlsx"),
    /--output must differ from --input/,
  );
  assert.throws(() => assertDistinctPaths("/x/../x/a.xlsx", "/x/a.xlsx"));
  assert.doesNotThrow(() => assertDistinctPaths("a.xlsx", "b.xlsx"));
});

const dir = mkdtempSync(join(tmpdir(), "rpa-args-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("assertDistinctPaths sees through a symlink or a hard link to the input", () => {
  const input = join(dir, "real.xlsx");
  writeFileSync(input, "x");
  symlinkSync(input, join(dir, "soft.xlsx"));
  linkSync(input, join(dir, "hard.xlsx"));
  assert.throws(
    () => assertDistinctPaths(input, join(dir, "soft.xlsx")),
    /--output must differ from --input/,
  );
  assert.throws(
    () => assertDistinctPaths(input, join(dir, "hard.xlsx")),
    /--output must differ from --input/,
  );
  assert.doesNotThrow(() =>
    assertDistinctPaths(input, join(dir, "other.xlsx")),
  );
});

test("assertDistinctPaths sees through a symlinked directory", () => {
  mkdirSync(join(dir, "data"));
  symlinkSync(join(dir, "data"), join(dir, "alias"));
  writeFileSync(join(dir, "data", "in.xlsx"), "x");
  // The output does not exist yet: its directory resolves to the input's.
  assert.throws(
    () =>
      assertDistinctPaths(
        join(dir, "data", "in.xlsx"),
        join(dir, "alias", "in.xlsx"),
      ),
    /--output must differ from --input/,
  );
});

test("assertDistinctPaths asks the filesystem whether two spellings are one file", () => {
  writeFileSync(join(dir, "In.xlsx"), "x");
  // Existing input, output spelled differently: the same file where the
  // filesystem ignores case (default macOS/Windows), two files where it does
  // not (case-sensitive APFS, Linux): only the filesystem knows, so it is asked
  // through `stat` instead of assuming from the platform.
  const existing = () =>
    assertDistinctPaths(join(dir, "In.xlsx"), join(dir, "in.xlsx"));
  const sameFile =
    statSync(join(dir, "In.xlsx"), { bigint: true }).ino ===
    (() => {
      try {
        return statSync(join(dir, "in.xlsx"), { bigint: true }).ino;
      } catch {
        return undefined;
      }
    })();
  if (sameFile) assert.throws(existing, /--output must differ from --input/);
  else assert.doesNotThrow(existing);
});

test("assertDistinctPaths: with neither file existing, only an identical spelling collides", () => {
  // No false positive on a case-sensitive volume, and nothing to overwrite
  // anywhere (the missing input is reported on its own).
  assert.doesNotThrow(() =>
    assertDistinctPaths(join(dir, "New.xlsx"), join(dir, "new.XLSX")),
  );
  assert.throws(
    () => assertDistinctPaths(join(dir, "New.xlsx"), join(dir, "New.xlsx")),
    /--output must differ from --input/,
  );
});

test("a usage mistake is an InputError, not a bare parseArgs error", () => {
  assert.throws(() => parseCliArgs(["--nope"]), InputError);
  assert.throws(() => parseCliArgs(["--input"]), InputError);
  assert.throws(() => parsePlaceholders(["bad"]), InputError);
  assert.throws(() => checkBaseUrl("not a url", false), InputError);
  assert.throws(() => assertDistinctPaths("a.xlsx", "a.xlsx"), InputError);
});
