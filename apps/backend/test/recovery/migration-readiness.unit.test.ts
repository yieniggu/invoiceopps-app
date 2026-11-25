import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  classifyMigrations,
  createMigrationReadiness,
  loadExpectedMigrations,
  qualifiedMigrationsTable,
  schemaFromDatabaseUrl,
} from "../../src/migrations.js";
import { createDatabase } from "../../src/database.js";

const expected = ["20260101000000_a", "20260102000000_b"] as const;

describe("classifyMigrations", () => {
  it("is ready when every expected migration is applied", () => {
    expect(classifyMigrations(expected, [...expected])).toBe("ready");
  });

  it("tolerates migrations a newer build already applied", () => {
    expect(
      classifyMigrations(expected, [...expected, "20260103000000_c"]),
    ).toBe("ready");
  });

  it("is pending when the latest migration is missing", () => {
    expect(classifyMigrations(expected, [expected[0]])).toBe(
      "migrations_pending",
    );
  });

  it("is pending when nothing was applied", () => {
    expect(classifyMigrations(expected, [])).toBe("migrations_pending");
  });
});

describe("createMigrationReadiness", () => {
  it("asks for the completed migrations once per probe", async () => {
    const completedMigrations = vi.fn(async () => [...expected]);
    const probe = createMigrationReadiness({ expected, completedMigrations });

    expect(await probe()).toBe("ready");
    expect(await probe()).toBe("ready");

    expect(completedMigrations).toHaveBeenCalledTimes(2);
    expect(completedMigrations).toHaveBeenCalledWith(expected);
  });

  it("reports pending migrations", async () => {
    const probe = createMigrationReadiness({
      expected,
      completedMigrations: async () => [expected[0]],
    });
    expect(await probe()).toBe("migrations_pending");
  });

  it("reports pending when the migrations table does not exist yet", async () => {
    const probe = createMigrationReadiness({
      expected,
      completedMigrations: async () => {
        throw new Error('relation "_prisma_migrations" does not exist');
      },
    });
    expect(await probe()).toBe("migrations_pending");
  });

  it("reports unavailable for any other failure", async () => {
    const probe = createMigrationReadiness({
      expected,
      completedMigrations: async () => {
        throw new Error("connection refused");
      },
    });
    expect(await probe()).toBe("unavailable");
  });
});

describe("loadExpectedMigrations", () => {
  it("lists the repository migrations, oldest first, ignoring files", () => {
    const names = loadExpectedMigrations();
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual([...names]);
    expect(names).not.toContain("migration_lock.toml");
  });

  it("reads only directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrations-"));
    mkdirSync(join(directory, "20260102000000_b"));
    mkdirSync(join(directory, "20260101000000_a"));
    writeFileSync(join(directory, "migration_lock.toml"), "x");

    expect(loadExpectedMigrations(directory)).toEqual([
      "20260101000000_a",
      "20260102000000_b",
    ]);
  });

  it("fails loudly when there are none", () => {
    const directory = mkdtempSync(join(tmpdir(), "migrations-"));
    expect(() => loadExpectedMigrations(directory)).toThrow(
      /No Prisma migrations/,
    );
  });
});

describe("migrations table schema (CR-016)", () => {
  it.each([
    ["postgresql://u:p@h:5432/db", "public"],
    ["postgresql://u:p@h:5432/db?schema=public", "public"],
    ["postgresql://u:p@h:5432/db?sslmode=disable&schema=tenant_1", "tenant_1"],
    ["not a url", "public"],
  ])("extracts the schema of %s", (url, schema) => {
    expect(schemaFromDatabaseUrl(url)).toBe(schema);
  });

  it("quotes the schema as an identifier", () => {
    expect(qualifiedMigrationsTable("postgresql://u:p@h/db?schema=app")).toBe(
      '"app"."_prisma_migrations"',
    );
  });

  it.each(['a"; DROP TABLE x;--', "a b", "1abc", "", "x".repeat(64)])(
    "fails fast on an invalid ?schema= (%j): it never reaches the SQL",
    (bad) => {
      const url = `postgresql://u:p@h/db?schema=${encodeURIComponent(bad)}`;
      expect(() => schemaFromDatabaseUrl(url)).toThrow(/invalid schema/i);
      expect(() => qualifiedMigrationsTable(url)).toThrow(/invalid schema/i);
    },
  );

  it("uses public only when ?schema= is absent", () => {
    expect(schemaFromDatabaseUrl("postgresql://u:p@h/db?sslmode=disable")).toBe(
      "public",
    );
  });
});

describe("createDatabase and the migrations schema (CR-027)", () => {
  const invalid = "postgresql://user:pass@127.0.0.1:5432/app?schema=a%20b";

  it("does not resolve the schema when readiness checks no migrations", async () => {
    const database = createDatabase(invalid);
    await database.close();
  });

  it("fails fast on an invalid schema when it checks migrations", () => {
    expect(() =>
      createDatabase(invalid, { expectedMigrations: [...expected] }),
    ).toThrow(/invalid schema/i);
  });
});
