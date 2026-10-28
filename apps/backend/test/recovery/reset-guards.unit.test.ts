import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertRecoveryTarget,
  expectedDatabasePort,
  parseResetArguments,
  safeDecode,
  sanitizeTarget,
} from "../../scripts/recovery-db-guards.mjs";
import { runRecoveryReset } from "../../scripts/recovery-local-reset.mjs";
import { runRecoveryPostgresTests } from "../../scripts/test-recovery-postgres.mjs";

const dev = "invoiceops";
const test = "invoiceops_recovery_test";
const secret = "s3cr3t-pa55";
const local = (name: string, host = "127.0.0.1:5545") =>
  `postgresql://user:${secret}@${host}/${name}?schema=public`;

describe("recovery reset guards", () => {
  it("accepts loopback hosts and both dedicated names with matching confirmation", () => {
    for (const host of ["localhost:5432", "127.0.0.1:5545", "[::1]:5432"]) {
      for (const name of [dev, test]) {
        const target = assertRecoveryTarget(local(name, host), {
          confirmReset: name,
        });
        expect(target.databaseName).toBe(name);
        expect(target.maintenanceUrl).toContain("/postgres");
      }
    }
  });

  it("checks the port against LOCAL_APP_DB_PORT only when it is configured", () => {
    const at = (port: string) => local(test, `127.0.0.1:${port}`);
    const options = (expectedPort?: string) => ({
      confirmReset: test,
      allowedNames: [test],
      expectedPort,
    });
    // Configured: only that port is this project's database.
    expect(() =>
      assertRecoveryTarget(at("5545"), options("5545")),
    ).not.toThrow();
    expect(() => assertRecoveryTarget(at("5432"), options("5545"))).toThrow(
      /port must be 5545/,
    );
    // An omitted port means 5432.
    expect(() =>
      assertRecoveryTarget(local(test, "127.0.0.1"), options("5545")),
    ).toThrow(/port must be 5545/);
    // Not configured (a CI service container): no expectation.
    expect(() => assertRecoveryTarget(at("5432"), options())).not.toThrow();
    // A unix socket has no port to compare.
    expect(() =>
      assertRecoveryTarget(`postgresql:///${test}?host=/var/run/postgresql`, {
        confirmReset: test,
        allowedNames: [test],
        expectedPort: "5545",
      }),
    ).not.toThrow();
    // The message never carries the URL or the password.
    try {
      assertRecoveryTarget(at("5432"), options("5545"));
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("reads the expected port from LOCAL_APP_DB_PORT, blank meaning none", () => {
    expect(expectedDatabasePort({ LOCAL_APP_DB_PORT: " 5545 " })).toBe("5545");
    expect(expectedDatabasePort({ LOCAL_APP_DB_PORT: "  " })).toBeUndefined();
    expect(expectedDatabasePort({})).toBeUndefined();
  });

  it("accepts a unix socket path host", () => {
    const target = assertRecoveryTarget(
      `postgresql:///${dev}?host=/var/run/postgresql`,
      { confirmReset: dev },
    );
    expect(target.databaseName).toBe(dev);
  });

  it.each([
    ["remote host", local(dev, "db.example.com:5432")],
    ["private network host", local(dev, "10.0.0.5:5432")],
    ["generic postgres name", local("postgres")],
    ["production-like name", local("invoiceops_prod")],
    ["removed recovery dev name", local("invoiceops_recovery_dev")],
    ["legacy test name", local("invoiceops_test")],
    ["prefix of dedicated name", local(`${dev}_2`)],
    ["malformed percent escape in name", local("invoiceops%E0%A4%A")],
    ["unknown protocol", `mysql://user:${secret}@127.0.0.1/${dev}`],
    ["invalid url", "not a url"],
    ["empty value", ""],
    [
      "host override query",
      `${local(dev, "localhost:5432")}&host=evil.example.com`,
    ],
    ["remote socket host param", `postgresql:///${dev}?host=evil.example.com`],
    [
      "socket with hostaddr override",
      `postgresql:///${dev}?host=/tmp&hostaddr=203.0.113.9`,
    ],
    [
      "socket with service override",
      `postgresql:///${dev}?host=/tmp&service=x`,
    ],
    ["socket with dbname override", `postgresql:///${dev}?host=/tmp&dbname=x`],
    ["socket with repeated host", `postgresql:///${dev}?host=/tmp&host=/var`],
  ])("rejects %s before any connection", (_label, url) => {
    expect(() => assertRecoveryTarget(url, { confirmReset: dev })).toThrow();
  });

  it.each([
    "port",
    "user",
    "password",
    "options",
    "sslrootcert",
    "Host",
    "HOST",
    "hostaddr",
    "Hostaddr",
    "service",
    "dbname",
  ])("rejects the %s query parameter on TCP and socket URLs", (key) => {
    expect(() =>
      assertRecoveryTarget(`${local(dev, "localhost:5432")}&${key}=x`, {
        confirmReset: dev,
      }),
    ).toThrow();
    expect(() =>
      assertRecoveryTarget(`postgresql:///${dev}?host=/tmp&${key}=x`, {
        confirmReset: dev,
      }),
    ).toThrow();
  });

  it("accepts only the allowlisted query parameters", () => {
    expect(
      assertRecoveryTarget(
        `postgresql://u:${secret}@localhost:5432/${dev}?schema=public&sslmode=disable&connect_timeout=5`,
        { confirmReset: dev },
      ).databaseName,
    ).toBe(dev);
    expect(
      assertRecoveryTarget(
        `postgresql:///${dev}?host=/tmp&sslmode=disable&schema=public`,
        { confirmReset: dev },
      ).databaseName,
    ).toBe(dev);
  });

  it("accepts the dev database only with its matching confirmation", () => {
    expect(() => assertRecoveryTarget(local(dev), {})).toThrow(/confirm/i);
    expect(() =>
      assertRecoveryTarget(local(dev), { confirmReset: "invoiceops_other" }),
    ).toThrow(/confirm/i);
    expect(
      assertRecoveryTarget(local(dev), { confirmReset: dev }).databaseName,
    ).toBe("invoiceops");
  });

  it("decodes safely and never throws a raw URIError", () => {
    expect(safeDecode("p%40ss")).toBe("p@ss");
    expect(safeDecode("bad%E0%A4%A")).toBe("bad%E0%A4%A");
    expect(safeDecode("bad%E0%A4%A", null)).toBeNull();
    expect(() =>
      assertRecoveryTarget(local("invoiceops%E0%A4%A"), { confirmReset: dev }),
    ).toThrow(/database name is not valid/);
    expect(sanitizeTarget(local("x%E0%A4%A"))).toBe("127.0.0.1:5545/x%E0%A4%A");
  });

  it("rejects missing and mismatched confirmation", () => {
    expect(() => assertRecoveryTarget(local(dev), {})).toThrow(/confirm/i);
    expect(() =>
      assertRecoveryTarget(local(dev), { confirmReset: test }),
    ).toThrow(/confirm/i);
  });

  it("restricts to explicitly allowed names", () => {
    expect(() =>
      assertRecoveryTarget(local(dev), {
        confirmReset: dev,
        allowedNames: [test],
      }),
    ).toThrow();
  });

  it("never leaks credentials in errors or sanitized targets", () => {
    for (const url of [local("postgres"), local(dev, "db.example.com:5432")]) {
      try {
        assertRecoveryTarget(url, { confirmReset: dev });
        throw new Error("expected rejection");
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
        expect((error as Error).message).not.toContain("user:");
      }
    }
    const sanitized = sanitizeTarget(local(dev));
    expect(sanitized).toBe(`127.0.0.1:5545/${dev}`);
  });

  it("parses arguments, ignoring a standalone separator", () => {
    expect(
      parseResetArguments(["--", `--confirm-reset=${dev}`], {
        DATABASE_URL: local(dev),
      }),
    ).toMatchObject({ url: local(dev), confirmReset: dev });
    expect(
      parseResetArguments(
        ["--database-url-env", "OTHER_URL", `--confirm-reset=${test}`],
        { OTHER_URL: local(test) },
      ),
    ).toMatchObject({ url: local(test), confirmReset: test });
    expect(() => parseResetArguments([], {})).toThrow(/DATABASE_URL/);
    expect(() => parseResetArguments(["--unknown"], {})).toThrow();
  });

  it("does not echo unknown positional arguments", () => {
    const urlArgument = `postgresql://user:${secret}@db.example.com/x`;
    try {
      parseResetArguments([urlArgument], {});
      throw new Error("expected rejection");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/unknown argument at position 1/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("db.example.com");
    }
  });
});

describe("recovery reset entry", () => {
  it("rejects guard failures without constructing a database client or spawning", async () => {
    const createClient = vi.fn();
    const spawn = vi.fn();
    const log = vi.fn();
    for (const [argv, url] of [
      [[`--confirm-reset=${dev}`], local(dev, "db.example.com:5432")],
      [[`--confirm-reset=postgres`], local("postgres")],
      [[], local(dev)],
    ] as const) {
      await expect(
        runRecoveryReset({
          argv: [...argv],
          env: { DATABASE_URL: url },
          createClient,
          spawn,
          log,
        }),
      ).rejects.toThrow();
    }
    expect(createClient).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("redacts URLs and passwords from driver and prisma failures", async () => {
    const encoded = "p%40ss";
    const url = `postgresql://user:${encoded}@127.0.0.1:5545/${test}?schema=public`;
    const target = assertRecoveryTarget(url, { confirmReset: test });
    const queries: string[] = [];
    const failing = {
      connect: async () => {},
      query: async (sql: string) => {
        queries.push(sql);
        throw new Error(
          `boom ${target.url} ${target.maintenanceUrl} ${encoded} p@ss`,
        );
      },
      end: async () => {},
    };
    const error = await runRecoveryReset({
      argv: [`--confirm-reset=${test}`],
      env: { DATABASE_URL: url },
      createClient: async () => failing,
      spawn: vi.fn(),
      log: vi.fn(),
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain("[redacted]");
    for (const leaked of [encoded, "p@ss", target.url, target.maintenanceUrl]) {
      expect((error as Error).message).not.toContain(leaked);
    }

    const ok = {
      connect: async () => {},
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      end: async () => {},
    };
    const spawned = await runRecoveryReset({
      argv: [`--confirm-reset=${test}`],
      env: { DATABASE_URL: url },
      createClient: async () => ok,
      spawn: () => ({
        status: 1,
        stderr: `fail ${target.url} ${encoded} p@ss`,
        stdout: "",
      }),
      log: vi.fn(),
    }).catch((e: Error) => e);
    for (const leaked of [encoded, "p@ss", target.url]) {
      expect((spawned as Error).message).not.toContain(leaked);
    }
    expect(queries.some((q) => q.includes("WITH (FORCE)"))).toBe(true);
  });

  it("redacts a malformed percent-encoded password without throwing URIError", async () => {
    const bad = "p%E0%A4%A";
    const url = `postgresql://user:${bad}@127.0.0.1:5545/${test}?schema=public`;
    const failing = {
      connect: async () => {},
      query: async () => {
        throw new Error(`boom ${bad}`);
      },
      end: async () => {},
    };
    const error = await runRecoveryReset({
      argv: [`--confirm-reset=${test}`],
      env: { DATABASE_URL: url },
      createClient: async () => failing,
      spawn: vi.fn(),
      log: vi.fn(),
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain("[redacted]");
    expect((error as Error).message).not.toContain(bad);
    expect((error as Error).name).not.toBe("URIError");
  });

  it("exits non-zero from the real entry point with no credential output", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/recovery-local-reset.mjs"), `--confirm-reset=${dev}`],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: local(dev, "db.example.com:5432"),
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(secret);
  });
});

describe("recovery postgres runner", () => {
  it("rejects a URL pointing to the dev database without resetting or spawning", async () => {
    const reset = vi.fn();
    const spawn = vi.fn();
    const error = await runRecoveryPostgresTests({
      env: { PATH: "/bin", RECOVERY_TEST_DATABASE_URL: local(dev) },
      reset,
      spawn,
      log: vi.fn(),
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/refused/);
    expect((error as Error).message).not.toContain(secret);
    expect(reset).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the PostgreSQL files one at a time on the shared test database", async () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    await runRecoveryPostgresTests({
      env: { PATH: "/bin", RECOVERY_TEST_DATABASE_URL: local(test) },
      reset: vi.fn(),
      spawn,
      log: vi.fn(),
    });

    const vitest = (spawn.mock.calls as unknown as Array<[string, string[]]>)
      .map(([, args]) => args)
      .find((args) => args.includes("vitest"));
    expect(vitest).toContain("--no-file-parallelism");
  });

  it("fails without RECOVERY_TEST_DATABASE_URL instead of skipping", async () => {
    const reset = vi.fn();
    const spawn = vi.fn();
    await expect(
      runRecoveryPostgresTests({ env: {}, reset, spawn, log: vi.fn() }),
    ).rejects.toThrow(/RECOVERY_TEST_DATABASE_URL/);
    expect(reset).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("recovery reset statements", () => {
  function recordingReset(name: string) {
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const log = vi.fn((message: string) => {
      events.push(`log:${message}`);
    });
    const createClient = vi.fn(async () => {
      events.push("createClient");
      return {
        connect: async () => {
          events.push("connect");
        },
        query: async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          return { rows: [] };
        },
        end: async () => {},
      };
    });
    const run = () =>
      runRecoveryReset({
        argv: [`--confirm-reset=${name}`],
        env: { DATABASE_URL: local(name) },
        createClient,
        spawn: () => ({ status: 0 }),
        log,
      });
    return { events, queries, run };
  }

  it("logs the sanitized target before creating the client", async () => {
    const { events, run } = recordingReset(dev);
    await run();
    const targetLog = `log:reset: target 127.0.0.1:5545/${dev}`;
    expect(events.indexOf(targetLog)).toBe(0);
    expect(events.indexOf("createClient")).toBeGreaterThan(
      events.indexOf(targetLog),
    );
    expect(events.join("\n")).not.toContain(secret);
  });

  it("terminates sessions, drops with FORCE and creates the quoted dev database in order", async () => {
    const { queries, run } = recordingReset(dev);
    await run();
    expect(queries).toEqual([
      {
        sql: "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        values: [dev],
      },
      { sql: 'DROP DATABASE IF EXISTS "invoiceops" WITH (FORCE)' },
      { sql: 'CREATE DATABASE "invoiceops"' },
    ]);
  });
});
