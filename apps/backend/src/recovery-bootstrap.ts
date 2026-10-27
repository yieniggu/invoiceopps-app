import { createDatabase } from "./database.js";
import {
  createTerminalPrompts,
  type BootstrapPrompts,
  runBootstrapCli,
} from "./features/auth/bootstrap-cli.js";
import { createBootstrapService } from "./features/auth/bootstrap-service.js";

async function main() {
  const argv = process.argv.slice(2);
  // Built lazily so --help and argument errors never require a terminal.
  let terminal: BootstrapPrompts | undefined;
  const prompts: BootstrapPrompts = {
    ask: (question) =>
      (terminal ??= createTerminalPrompts(process.stdin, process.stdout)).ask(
        question,
      ),
    askSecret: (question) =>
      (terminal ??= createTerminalPrompts(
        process.stdin,
        process.stdout,
      )).askSecret(question),
  };

  return runBootstrapCli({
    argv,
    databaseUrl: process.env.DATABASE_URL,
    prompts,
    createService: (databaseUrl) => {
      const database = createDatabase(databaseUrl);
      return {
        service: createBootstrapService(database.prisma),
        close: () => database.prisma.$disconnect(),
      };
    },
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^The bootstrap requires/.test(error.message)
        ? `${error.message}\n`
        : "The bootstrap failed; nothing was changed.\n",
    );
    process.exitCode = 1;
  });
