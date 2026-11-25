import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Outcome of a readiness probe; the database is the only thing it checks. */
export type Readiness = "ready" | "unavailable" | "migrations_pending";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../prisma/migrations", import.meta.url),
);

/**
 * Names of the migrations this build expects, oldest first. Read once at
 * startup: the directory ships with the image (`src` and `dist` both sit next
 * to `prisma/`), so a missing one is a broken build and fails loudly here.
 */
export function loadExpectedMigrations(
  directory: string = MIGRATIONS_DIRECTORY,
): readonly string[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`No Prisma migrations found in ${directory}`);
  }
  return names;
}

/**
 * The schema is current only when every expected migration finished and was
 * not rolled back. Extra applied migrations (a newer build ran first) are not
 * a problem for this one.
 */
export function classifyMigrations(
  expected: readonly string[],
  completed: readonly string[],
): "ready" | "migrations_pending" {
  const done = new Set(completed);
  return expected.every((name) => done.has(name))
    ? "ready"
    : "migrations_pending";
}

/** A missing `_prisma_migrations` table means no migration was ever applied. */
function isMigrationTableMissing(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /_prisma_migrations/.test(text) && /does not exist/.test(text);
}

/**
 * One probe = one bounded query (at most one row per expected migration). A
 * failure means "pending" only when the migrations table does not exist yet;
 * any other failure is an unavailable database.
 */
export function createMigrationReadiness({
  expected,
  completedMigrations,
}: {
  expected: readonly string[];
  completedMigrations(expected: readonly string[]): Promise<string[]>;
}): () => Promise<Readiness> {
  return async () => {
    try {
      return classifyMigrations(expected, await completedMigrations(expected));
    } catch (error) {
      return isMigrationTableMissing(error)
        ? "migrations_pending"
        : "unavailable";
    }
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/**
 * Schema named by the `?schema=` parameter of a database URL (`public` when
 * the parameter is absent or the URL is unparsable: the database client
 * rejects that itself). A present but invalid value throws, so the server
 * fails at startup instead of silently reading another schema, and nothing but
 * a plain identifier can ever reach the SQL text.
 */
export function schemaFromDatabaseUrl(databaseUrl: string): string {
  let value: string | null;
  try {
    value = new URL(databaseUrl).searchParams.get("schema");
  } catch {
    return "public";
  }
  if (value === null) return "public";
  if (!IDENTIFIER.test(value))
    throw new Error(
      "DATABASE_URL has an invalid schema parameter: use a plain identifier",
    );
  return value;
}

/** Fully qualified, double-quoted `_prisma_migrations` identifier. */
export function qualifiedMigrationsTable(databaseUrl: string): string {
  return `"${schemaFromDatabaseUrl(databaseUrl)}"."_prisma_migrations"`;
}
