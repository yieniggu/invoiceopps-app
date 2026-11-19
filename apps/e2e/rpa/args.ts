import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * A mistake in what the person handed the bot (arguments, URL, workbook
 * shape): the CLI answers with the usage text and exit code 2, never a stack.
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Local dev frontend (LOCAL_RUN.md, route A). */
export const DEFAULT_BASE_URL = "http://127.0.0.1:5380";

/**
 * `pnpm run rpa:run -- --input in.xlsx` hands the script a literal `--` first,
 * and `parseArgs` would read the rest as positionals. Drop that one separator.
 */
export function dropLeadingSeparator(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

export interface CliArgs {
  input?: string;
  output?: string;
  baseUrl: string;
  headed: boolean;
  allowRemote: boolean;
  set: string[];
  help: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed: ReturnType<typeof parseValues>;
  try {
    parsed = parseValues(argv);
  } catch (error) {
    throw new InputError((error as Error).message);
  }
  const values = parsed;
  return {
    input: values.input,
    output: values.output,
    baseUrl: values["base-url"],
    headed: values.headed,
    allowRemote: values["allow-remote"],
    set: values.set,
    help: values.help,
  };
}

function parseValues(argv: readonly string[]) {
  return parseArgs({
    args: dropLeadingSeparator(argv),
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      headed: { type: "boolean", default: false },
      "allow-remote": { type: "boolean", default: false },
      set: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  }).values;
}

/** `KEY=VALUE` entries of `--set`; the value may itself contain `=`. */
export function parsePlaceholders(
  entries: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    entries.map((entry) => {
      const at = entry.indexOf("=");
      if (at < 1)
        throw new InputError(`--set expects KEY=VALUE, got "${entry}"`);
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The origin the bot may type credentials into. Loopback hosts are always
 * fine; any other host needs `--allow-remote` and https, so a typo or a pasted
 * link can not send the password to a third party in clear text.
 */
export function checkBaseUrl(raw: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError(`--base-url "${raw}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new InputError("--base-url must be an http or https URL");
  if (url.username !== "" || url.password !== "")
    throw new InputError("--base-url must not embed credentials");
  if (LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  if (!allowRemote)
    throw new InputError(
      `Refusing to type credentials into the non-loopback host "${url.hostname}". Pass --allow-remote if you really mean it.`,
    );
  if (url.protocol !== "https:")
    throw new InputError("--allow-remote requires an https --base-url");
  return url.origin;
}

/** `dev:ino` of an existing path, `undefined` when it does not exist. */
function fileId(path: string): string | undefined {
  try {
    const { dev, ino } = statSync(path, { bigint: true });
    return `${dev}:${ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Where a path really is: symlinks resolved (the file itself when it exists,
 * its directory otherwise, as the output usually does not exist yet). Case is
 * NOT folded: whether `In.xlsx` and `in.xlsx` are one file depends on the
 * volume (APFS can be case-sensitive), so `fileId` asks the filesystem.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch {
    let directory = dirname(absolute);
    try {
      directory = realpathSync(directory);
    } catch {
      // The directory is created later: its spelling is all there is.
    }
    real = join(directory, basename(absolute));
  }
  return real;
}

/**
 * Writing the result over the input would destroy the data the run came from.
 * Two spellings of one file count: symlinks, hard links and, where the volume
 * ignores case, `In.xlsx` against `in.xlsx`: all of them show up as one
 * `dev:ino` as soon as one of the two exists (the filesystem resolves the
 * other spelling). When neither exists there is nothing to overwrite, so only
 * an identical spelling collides.
 */
export function assertDistinctPaths(input: string, output: string): void {
  const inputId = fileId(input);
  const same =
    resolve(input) === resolve(output) ||
    (inputId !== undefined && inputId === fileId(output)) ||
    canonicalPath(input) === canonicalPath(output);
  if (same) throw new InputError("--output must differ from --input");
}
