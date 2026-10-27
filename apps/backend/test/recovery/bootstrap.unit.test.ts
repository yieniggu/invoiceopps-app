import { readFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  BOOTSTRAP_HELP,
  assertLocalDatabaseUrl,
  createTerminalPrompts,
  parseBootstrapArguments,
  runBootstrapCli,
  type BootstrapPrompts,
} from "../../src/features/auth/bootstrap-cli.js";
import {
  BootstrapInputError,
  BootstrapRejectedError,
  parseBootstrapInput,
  createBootstrapService,
  type BootstrapService,
} from "../../src/features/auth/bootstrap-service.js";

const SECRET = "temporary-secret-123";

function prompts(answers: Record<string, string>): BootstrapPrompts {
  return {
    ask: async (question) => answers[question] ?? "",
    askSecret: async (question) => answers[question] ?? "",
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (text: string) => void out.push(text),
    writeError: (text: string) => void err.push(text),
  };
}

function fakeService(overrides: Partial<BootstrapService> = {}) {
  return {
    bootstrap: vi.fn(async () => ({ outcome: "created", userId: "u1" })),
    designateExisting: vi.fn(async () => ({
      outcome: "designated",
      userId: "u2",
    })),
    ...overrides,
  } as unknown as BootstrapService;
}

async function run(
  argv: string[],
  answers: Record<string, string>,
  service = fakeService(),
  databaseUrl: string | null = "postgresql://u:p@127.0.0.1:5545/db",
) {
  const sink = capture();
  const createService = vi.fn(() => ({ service, close: async () => {} }));
  const code = await runBootstrapCli({
    argv,
    databaseUrl: databaseUrl ?? undefined,
    prompts: prompts(answers),
    createService,
    write: sink.write,
    writeError: sink.writeError,
  });
  return { code, sink, service, createService };
}

describe("RP0-03 bootstrap input validation", () => {
  it("accepts a valid name, RUT and password and canonicalizes the RUT", () => {
    expect(
      parseBootstrapInput({
        name: "  Ada Lovelace ",
        rut: "12.345.678-5",
        password: SECRET,
      }),
    ).toEqual({ name: "Ada Lovelace", rut: "123456785", password: SECRET });
  });

  it.each([
    [{ name: "", rut: "12.345.678-5", password: SECRET }],
    [{ name: "Ada", rut: "11.111.111-2", password: SECRET }],
    [{ name: "Ada", rut: "12.345.678-5", password: "short" }],
  ])("rejects %j without echoing the password", (input) => {
    const attempt = () => parseBootstrapInput(input);
    expect(attempt).toThrow(BootstrapInputError);
    try {
      attempt();
    } catch (error) {
      expect((error as Error).message).not.toContain(input.password);
    }
  });
});

describe("RP0-03 bootstrap concurrency conflicts", () => {
  const conflicting = {
    $transaction: async () => {
      throw Object.assign(new Error("write conflict"), { code: "P2034" });
    },
  };
  const message = "Bootstrap conflicted with a concurrent run; retry";

  it("reports exhausted retries as a specific bootstrap error", async () => {
    const service = createBootstrapService(conflicting as never);

    await expect(
      service.bootstrap({
        name: "Ada",
        rut: "12.345.678-5",
        password: "x".repeat(12),
      }),
    ).rejects.toThrow(message);
    await expect(
      service.designateExisting("12.345.678-5"),
    ).rejects.toBeInstanceOf(BootstrapRejectedError);
  });

  it("shows the conflict to the CLI user", async () => {
    const service = fakeService({
      bootstrap: vi.fn(async () => {
        throw new BootstrapRejectedError(message);
      }),
    } as never);
    const { code, sink } = await run([], {}, service);

    expect(code).toBe(1);
    expect(sink.err.join("")).toContain(message);
  });

  it("never passes the test-only hooks from the CLI entry point", () => {
    const source = readFileSync("src/recovery-bootstrap.ts", "utf8");
    expect(source).not.toMatch(/afterUserCreated|afterDesignated/);
  });
});

describe("RP0-03 bootstrap password bounds", () => {
  const input = (password: string) => ({
    name: "Ada",
    rut: "12.345.678-5",
    password,
  });

  it.each([
    ["12 characters", "x".repeat(12)],
    ["256 characters", "x".repeat(256)],
  ])("accepts %s", (_label, password) => {
    expect(parseBootstrapInput(input(password)).password).toBe(password);
  });

  it.each([
    ["11 characters", "x".repeat(11)],
    ["257 characters", "x".repeat(257)],
  ])(
    "rejects %s with the range and without echoing the password",
    (_label, password) => {
      try {
        parseBootstrapInput(input(password));
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(BootstrapInputError);
        expect((error as Error).message).toBe(
          "The temporary password must have between 12 and 256 characters",
        );
      }
    },
  );
});

describe("RP0-03 bootstrap command line", () => {
  it("parses the supported flags and rejects everything else", () => {
    expect(parseBootstrapArguments([])).toEqual({
      existingUser: false,
      help: false,
    });
    expect(parseBootstrapArguments(["--existing-user"])).toEqual({
      existingUser: true,
      help: false,
    });
    expect(parseBootstrapArguments(["--help"]).help).toBe(true);
    for (const argv of [
      ["--password=abc"],
      ["--existing-user", "extra"],
      ["--unknown"],
    ]) {
      expect(() => parseBootstrapArguments(argv)).toThrow(
        /Unrecognized argument/,
      );
    }
  });

  it("documents both modes in --help and runs nothing", async () => {
    expect(BOOTSTRAP_HELP).toContain("--existing-user");
    const { code, sink, createService } = await run(["--help"], {});
    expect(code).toBe(0);
    expect(sink.out.join("")).toContain("--existing-user");
    expect(createService).not.toHaveBeenCalled();
  });

  it("refuses a non-loopback DATABASE_URL before building any service", async () => {
    const { code, sink, createService } = await run(
      [],
      {},
      fakeService(),
      "postgresql://user:hunter2@db.example.com:5432/app",
    );
    expect(code).not.toBe(0);
    expect(createService).not.toHaveBeenCalled();
    expect(sink.err.join("")).not.toContain("hunter2");
    expect(sink.err.join("")).not.toContain("db.example.com");
  });

  it("requires DATABASE_URL", async () => {
    const { code, createService } = await run([], {}, fakeService(), null);
    expect(code).not.toBe(0);
    expect(createService).not.toHaveBeenCalled();
  });

  it("accepts loopback and unix socket hosts only", () => {
    for (const url of [
      "postgresql://u:p@127.0.0.1:5545/db",
      "postgres://u:p@localhost/db",
      "postgresql://u:p@[::1]:5432/db",
      "postgresql:///db?host=/var/run/postgresql",
    ])
      expect(() => assertLocalDatabaseUrl(url), url).not.toThrow();
    for (const url of [
      "postgresql://u:p@10.0.0.5:5432/db",
      "postgresql://u:p@db.internal/db",
      "postgresql:///db?host=remote.example",
      "mysql://u:p@127.0.0.1/db",
      "not a url",
    ])
      expect(() => assertLocalDatabaseUrl(url), url).toThrow();
  });
});

describe("RP0-03 bootstrap command flow", () => {
  const answers = {
    "Name: ": "Ada Lovelace",
    "RUT: ": "12.345.678-5",
    "Temporary password: ": SECRET,
    "Repeat the temporary password: ": SECRET,
  };

  it("creates the administrator and never prints the password", async () => {
    const { code, sink, service } = await run([], answers);
    expect(code).toBe(0);
    expect(service.bootstrap).toHaveBeenCalledWith({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: SECRET,
    });
    expect(sink.out.join("") + sink.err.join("")).not.toContain(SECRET);
  });

  it("rejects a mismatched confirmation before touching the service", async () => {
    const { code, sink, service } = await run([], {
      ...answers,
      "Repeat the temporary password: ": "other-secret-1234",
    });
    expect(code).not.toBe(0);
    expect(service.bootstrap).not.toHaveBeenCalled();
    expect(sink.err.join("") + sink.out.join("")).not.toContain(SECRET);
    expect(sink.err.join("") + sink.out.join("")).not.toContain(
      "other-secret-1234",
    );
  });

  it("reports an already initialized administrator as success", async () => {
    const service = fakeService({
      bootstrap: vi.fn(async () => ({ outcome: "unchanged", userId: "u1" })),
    } as never);
    const { code, sink } = await run([], answers, service);
    expect(code).toBe(0);
    expect(sink.out.join("")).toContain("already initialized");
  });

  it("exits non-zero when another user already holds the designation", async () => {
    const service = fakeService({
      bootstrap: vi.fn(async () => {
        throw new BootstrapRejectedError("Ya existe otro administrador");
      }),
    } as never);
    const { code, sink } = await run([], answers, service);
    expect(code).not.toBe(0);
    expect(sink.err.join("")).toContain("Ya existe otro administrador");
  });

  it("uses only the RUT prompt with --existing-user (no password prompt)", async () => {
    const askSecret = vi.fn(async () => SECRET);
    const sink = capture();
    const service = fakeService();
    const code = await runBootstrapCli({
      argv: ["--existing-user"],
      databaseUrl: "postgresql://u:p@127.0.0.1:5545/db",
      prompts: { ask: async () => "12.345.678-5", askSecret },
      createService: () => ({ service, close: async () => {} }),
      write: sink.write,
      writeError: sink.writeError,
    });
    expect(code).toBe(0);
    expect(askSecret).not.toHaveBeenCalled();
    expect(service.designateExisting).toHaveBeenCalledWith("12.345.678-5");
  });

  it("closes the database even when the service fails", async () => {
    const close = vi.fn(async () => {});
    const sink = capture();
    const code = await runBootstrapCli({
      argv: [],
      databaseUrl: "postgresql://u:p@127.0.0.1:5545/db",
      prompts: prompts(answers),
      createService: () => ({
        service: fakeService({
          bootstrap: vi.fn(async () => {
            throw new Error(`boom ${SECRET}`);
          }),
        } as never),
        close,
      }),
      write: sink.write,
      writeError: sink.writeError,
    });
    expect(code).not.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(sink.err.join("")).not.toContain(SECRET);
  });
});

describe("RP0-03 terminal prompts", () => {
  it("refuses to prompt when stdin is not a TTY", () => {
    const input = Object.assign(Readable.from([]), { isTTY: false });
    expect(() => createTerminalPrompts(input as never, process.stdout)).toThrow(
      /interactive terminal/,
    );
  });

  it("rejects a pending prompt when the input stream ends (EOF)", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const prompts = createTerminalPrompts(input as never, output);

    const answer = prompts.ask("RUT: ");
    input.end();

    await expect(answer).rejects.toThrow(/input was closed/);
  });

  it("rejects a pending secret prompt on EOF without echoing anything", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(String(chunk)));
    const prompts = createTerminalPrompts(input as never, output);

    const answer = prompts.askSecret("Temporary password: ");
    input.write("partial-secret");
    input.end();

    await expect(answer).rejects.toThrow(/input was closed/);
    expect(written.join("")).not.toContain("partial-secret");
  });

  it("still resolves a normal answer", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const prompts = createTerminalPrompts(input as never, new PassThrough());

    const answer = prompts.ask("RUT: ");
    input.write("12.345.678-5\r");

    await expect(answer).resolves.toBe("12.345.678-5");
  });

  it("exits 1 with an English message when the prompts hit EOF", async () => {
    const sink = capture();
    const code = await runBootstrapCli({
      argv: [],
      databaseUrl: "postgresql://u:p@127.0.0.1:5545/db",
      prompts: {
        ask: async () => {
          throw new Error(
            "The bootstrap requires an answer: the input was closed before finishing",
          );
        },
        askSecret: async () => "",
      },
      createService: () => ({ service: fakeService(), close: async () => {} }),
      write: sink.write,
      writeError: sink.writeError,
    });

    expect(code).toBe(1);
    expect(sink.err.join("")).toContain("input was closed");
  });

  it("never reads the password from argv or the environment", () => {
    const source = readFileSync("src/features/auth/bootstrap-cli.ts", "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/process\.argv/);
  });
});
