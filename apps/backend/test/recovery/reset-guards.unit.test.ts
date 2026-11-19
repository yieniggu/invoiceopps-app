import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const pgClientConfigs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("pg", () => ({
  default: {
    Client: class {
      constructor(config: Record<string, unknown>) {
        pgClientConfigs.push(config);
      }
      connect = async () => {};
      query = async () => ({ rows: [] });
      end = async () => {};
    },
  },
}));

import {
  assertRecoveryTarget,
  expectedDatabasePort,
  parseResetArguments,
  recoveryDatabaseNames,
  safeDecode,
  sanitizeTarget,
} from "../../scripts/recovery-db-guards.mjs";
import {
  prismaBin,
  runRecoveryReset,
  spawnWithGroupKill,
} from "../../scripts/recovery-local-reset.mjs";
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

  it("reports that the migrations (all of them, not one baseline) were applied", async () => {
    const { events, run } = recordingReset(dev);
    await run();
    expect(events).toContain("log:reset: migrations applied");
    expect(events.join("\n")).not.toContain("consolidated");
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

// CR-262 / RP0-20: the browser E2E suite gets its own database so it never
// shares (or force-drops the connections of) invoiceops_recovery_test while
// `test:recovery:postgres` runs. Same guards; each launcher allows only its own.
describe("dedicated E2E database target", () => {
  const e2e = "invoiceops_recovery_e2e";

  it("is one of the recovery database names", () => {
    expect(recoveryDatabaseNames).toEqual(
      expect.arrayContaining([dev, test, e2e]),
    );
  });

  it("accepts the E2E database on loopback with its own confirmation", () => {
    const target = assertRecoveryTarget(local(e2e), {
      confirmReset: e2e,
      allowedNames: [e2e],
      expectedPort: "5545",
    });
    expect(target.databaseName).toBe(e2e);
    expect(target.sanitized).toBe(`127.0.0.1:5545/${e2e}`);
  });

  it("keeps the E2E and recovery test targets apart", () => {
    // The E2E launcher allows only its database...
    for (const name of [dev, test]) {
      expect(() =>
        assertRecoveryTarget(local(name), {
          confirmReset: name,
          allowedNames: [e2e],
        }),
      ).toThrow(/database name must be exactly invoiceops_recovery_e2e/);
    }
    // ...and the PostgreSQL runner never resets the E2E one.
    expect(() =>
      assertRecoveryTarget(local(e2e), {
        confirmReset: e2e,
        allowedNames: [test],
      }),
    ).toThrow(/database name must be exactly invoiceops_recovery_test/);
  });

  it("requires the confirmation to name the E2E database itself", () => {
    expect(() =>
      assertRecoveryTarget(local(e2e), {
        confirmReset: test,
        allowedNames: [e2e],
      }),
    ).toThrow(/--confirm-reset=invoiceops_recovery_e2e/);
  });

  it("still refuses a non-loopback host for the E2E database", () => {
    expect(() =>
      assertRecoveryTarget(local(e2e, "db.example.com:5432"), {
        confirmReset: e2e,
        allowedNames: [e2e],
      }),
    ).toThrow(/host must be/);
  });
});

describe("recovery reset: bounded database work and child processes", () => {
  it("the default client fails a stuck statement instead of waiting for the caller", async () => {
    const spawn = vi.fn(async () => ({ status: 0 }));
    await runRecoveryReset({
      argv: [`--confirm-reset=${test}`],
      env: { DATABASE_URL: local(test) },
      spawn,
      log: vi.fn(),
    });
    expect(pgClientConfigs).toHaveLength(1);
    const config = pgClientConfigs[0] as Record<string, number>;
    expect(config.connectionTimeoutMillis).toBe(5000);
    expect(config.statement_timeout).toBe(60_000);
    expect(config.query_timeout).toBe(65_000);
    // The client timeouts are shorter than the migrate budget below.
    expect(config.query_timeout).toBeLessThan(180_000);
  });

  it("runs prisma directly (no pnpm wrapper) under a timeout that kills the group", async () => {
    const spawn = vi.fn(async () => ({ status: 0 }));
    await runRecoveryReset({
      argv: [`--confirm-reset=${test}`],
      env: { DATABASE_URL: local(test), PATH: "/bin" },
      createClient: async () => ({
        connect: async () => {},
        query: async () => ({ rows: [] }),
        end: async () => {},
      }),
      spawn,
      log: vi.fn(),
    });
    const [command, args, options] = spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout: number; env: Record<string, string> },
    ];
    expect(command).toBe(prismaBin);
    expect(command).not.toBe("pnpm");
    expect(args).toEqual(["migrate", "deploy"]);
    expect(options.timeout).toBe(180_000);
    // The default spawner is the one that owns a process group.
    expect(spawnWithGroupKill).toBeTypeOf("function");
  });

  it("on timeout kills the whole process group, not only the direct child", async () => {
    const killGroup = vi.fn();
    const result = await spawnWithGroupKill(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        timeout: 100,
        killGroup: (pid: number) => {
          killGroup(pid);
          process.kill(-pid, "SIGKILL");
        },
      },
    );
    expect(killGroup).toHaveBeenCalledTimes(1);
    expect((result as { error: Error }).error.message).toMatch(/timed out/);
    expect((result as { status: number | null }).status).toBeNull();
  });

  it("a grandchild of the migrate command does not outlive the timeout", async () => {
    // The direct child starts a grandchild (as pnpm does with prisma) and
    // prints its pid; a SIGKILL to the direct child alone would leave it alive.
    const parent = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      console.log("GRANDCHILD " + grandchild.pid);
      setInterval(() => {}, 1000);
    `;
    const result = (await spawnWithGroupKill(process.execPath, ["-e", parent], {
      timeout: 1500,
    })) as { stdout: string };
    const pid = Number(/GRANDCHILD (\d+)/.exec(result.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((done) => setTimeout(done, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("on win32 spawns through a shell (prisma.cmd) and quotes the binary; POSIX stays direct (CR-431)", async () => {
    const calls: Array<{ command: string; options: Record<string, unknown> }> =
      [];
    const fakeSpawn = ((
      command: string,
      _args: string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ command, options });
      const child = new EventEmitter() as EventEmitter & {
        stdout: null;
        stderr: null;
        pid: number;
      };
      child.stdout = null;
      child.stderr = null;
      child.pid = 1;
      setImmediate(() => child.emit("close", 0));
      return child;
    }) as never;
    await spawnWithGroupKill("C:\\x y\\prisma.cmd", ["migrate"], {
      spawnImpl: fakeSpawn,
      platform: "win32",
    });
    await spawnWithGroupKill("/x/prisma", ["migrate"], {
      spawnImpl: fakeSpawn,
      platform: "linux",
    });
    expect(calls[0]?.command).toBe('"C:\\x y\\prisma.cmd"');
    expect(calls[0]?.options.shell).toBe(true);
    expect(calls[0]?.options.detached).toBe(false);
    expect(calls[1]?.command).toBe("/x/prisma");
    expect(calls[1]?.options.shell).toBe(false);
    expect(calls[1]?.options.detached).toBe(true);
  });

  it("resolves with the exit status and output of a command that ends in time", async () => {
    const result = (await spawnWithGroupKill(
      process.execPath,
      ["-e", "console.log('ok'); process.exit(3)"],
      { timeout: 5000 },
    )) as { status: number; stdout: string };
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("ok");
  });
});
