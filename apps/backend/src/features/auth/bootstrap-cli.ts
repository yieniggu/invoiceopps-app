import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { assertLocalDatabaseUrl } from "../../local-database-url.js";
import {
  BootstrapInputError,
  BootstrapRejectedError,
  type BootstrapService,
} from "./bootstrap-service.js";

export { assertLocalDatabaseUrl };

export const BOOTSTRAP_HELP = `Usage: pnpm recovery:bootstrap [--existing-user]

Creates the first platform administrator of an empty local database.
Prompts for name, RUT and a temporary password (twice, no echo). The password
is never accepted through arguments or environment variables.

  (no options)     Creates the user with a temporary password (24 h, forced
                   change) and designates it platform administrator.
  --existing-user  Designates an existing user by RUT. Only if the user already
                   has a usable credential; does not prompt for a password.
  --help           Shows this help.

Repeating with the same RUT changes nothing. A different RUT is rejected.
A user whose temporary password already expired is rejected.
Only works against a local DATABASE_URL (loopback or unix socket).
`;

export interface BootstrapArguments {
  existingUser: boolean;
  help: boolean;
}

export function parseBootstrapArguments(argv: string[]): BootstrapArguments {
  const parsed = { existingUser: false, help: false };
  for (const argument of argv) {
    if (argument === "--existing-user") parsed.existingUser = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else throw new Error("Unrecognized argument; use --help");
  }
  return parsed;
}

const INPUT_CLOSED_MESSAGE =
  "The bootstrap requires an answer: the input was closed before finishing";

export interface BootstrapPrompts {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
}

export function createTerminalPrompts(
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
): BootstrapPrompts {
  if (!input.isTTY) {
    throw new Error(
      "The bootstrap requires an interactive terminal (stdin is not a TTY)",
    );
  }
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });

  async function prompt(question: string, hidden: boolean) {
    output.write(question);
    const readline = createInterface({
      input,
      output: hidden ? muted : output,
      terminal: true,
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        // EOF (Ctrl-D, closed pipe) and Ctrl-C close the interface without an
        // answer; reject instead of leaving the prompt pending forever.
        readline.once("close", () => reject(new Error(INPUT_CLOSED_MESSAGE)));
        readline.once("SIGINT", () => readline.close());
        readline.question("", resolve);
      });
    } finally {
      readline.close();
      if (hidden) output.write("\n");
    }
  }

  return {
    ask: (question) => prompt(question, false),
    askSecret: (question) => prompt(question, true),
  };
}

export interface BootstrapCliOptions {
  argv: string[];
  databaseUrl: string | undefined;
  prompts: BootstrapPrompts;
  createService(databaseUrl: string): {
    service: BootstrapService;
    close(): Promise<void>;
  };
  write(text: string): void;
  writeError(text: string): void;
}

/** Runs the bootstrap command and returns the process exit code. */
export async function runBootstrapCli({
  argv,
  databaseUrl,
  prompts,
  createService,
  write,
  writeError,
}: BootstrapCliOptions): Promise<number> {
  try {
    const options = parseBootstrapArguments(argv);
    if (options.help) {
      write(BOOTSTRAP_HELP);
      return 0;
    }
    if (!databaseUrl) throw new Error("DATABASE_URL must be configured");
    assertLocalDatabaseUrl(databaseUrl);

    const { service, close } = createService(databaseUrl);
    try {
      let result;
      if (options.existingUser) {
        result = await service.designateExisting(await prompts.ask("RUT: "));
      } else {
        const name = await prompts.ask("Name: ");
        const rut = await prompts.ask("RUT: ");
        const password = await prompts.askSecret("Temporary password: ");
        const confirmation = await prompts.askSecret(
          "Repeat the temporary password: ",
        );
        if (password !== confirmation) {
          throw new BootstrapInputError("The passwords do not match");
        }
        result = await service.bootstrap({ name, rut, password });
      }
      write(
        result.outcome === "unchanged"
          ? "Platform administrator already initialized; nothing was changed.\n"
          : result.outcome === "created"
            ? "Platform administrator created with a temporary password (24 h).\n"
            : "Existing user designated platform administrator.\n",
      );
      return 0;
    } finally {
      await close();
    }
  } catch (error) {
    writeError(
      error instanceof BootstrapInputError ||
        error instanceof BootstrapRejectedError ||
        (error instanceof Error && isSafeCliError(error))
        ? `${error.message}\n`
        : "The bootstrap failed; nothing was changed.\n",
    );
    return 1;
  }
}

// Argument, TTY and database-URL errors are authored in this feature and never
// carry secrets; everything else (driver errors) is reported generically.
function isSafeCliError(error: Error) {
  return /^(Unrecognized argument|DATABASE_URL|The bootstrap requires)/.test(
    error.message,
  );
}
