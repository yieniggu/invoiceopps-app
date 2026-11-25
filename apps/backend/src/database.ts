import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import {
  createMigrationReadiness,
  qualifiedMigrationsTable,
  type Readiness,
} from "./migrations.js";

export interface DatabaseReadiness {
  isReady(): Promise<boolean>;
  /** Richer probe that also reports pending migrations; preferred when set. */
  readiness?(): Promise<Readiness>;
}

export interface Database extends DatabaseReadiness {
  readiness(): Promise<Readiness>;
  prisma: PrismaClient;
  /** Releases the connection pool; call once after the server stopped. */
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /**
   * Migrations this build expects (see `loadExpectedMigrations`). When set,
   * `readiness()` also verifies they are all applied; otherwise it only
   * checks connectivity.
   */
  expectedMigrations?: readonly string[];
}

export function createDatabase(
  databaseUrl: string,
  { expectedMigrations }: DatabaseOptions = {},
): Database {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  const ping = async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  };
  // The migrations table (and its `?schema=` validation) only matters to the
  // readiness check: callers without `expectedMigrations` (CLIs, seed, tests)
  // never resolve it, so a schema they never query cannot stop them.
  const migrationReadiness = expectedMigrations
    ? (() => {
        const migrationsTable = Prisma.raw(
          qualifiedMigrationsTable(databaseUrl),
        );
        return createMigrationReadiness({
          expected: expectedMigrations,
          async completedMigrations(expected) {
            const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
              SELECT migration_name FROM ${migrationsTable}
              WHERE finished_at IS NOT NULL
                AND rolled_back_at IS NULL
                AND migration_name = ANY(${[...expected]})`;
            return rows.map((row) => row.migration_name);
          },
        });
      })()
    : undefined;

  return {
    prisma,
    async close() {
      await prisma.$disconnect();
    },
    isReady: ping,
    async readiness() {
      if (migrationReadiness) return migrationReadiness();
      return (await ping()) ? "ready" : "unavailable";
    },
  };
}

export function createDatabaseReadiness(
  databaseUrl: string,
): DatabaseReadiness {
  return createDatabase(databaseUrl);
}
