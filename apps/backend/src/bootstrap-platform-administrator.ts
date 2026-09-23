import { createDatabase } from "./database.js";
import { AuthError } from "./auth.js";
import { parsePlatformAdministratorCommand } from "./platform-administrator-command.js";
import { createPlatformAdministratorService } from "./platform-administrator.js";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be configured");
  }

  const { operation, userId } = parsePlatformAdministratorCommand(
    process.argv.slice(2),
  );
  const database = createDatabase(databaseUrl);
  const service = createPlatformAdministratorService(database.prisma);

  try {
    if (operation === "bootstrap") {
      await service.bootstrap(userId);
    } else {
      await service.transfer(userId);
    }
  } finally {
    await database.prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof AuthError || error instanceof Error
      ? error.message
      : "Platform administrator command failed";
  console.error(message);
  process.exitCode = 1;
});
