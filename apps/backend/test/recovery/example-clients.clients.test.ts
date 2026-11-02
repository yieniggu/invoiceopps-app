import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { DAY_MS } from "./api-token-fixtures.js";
import { membershipFixtures, NO_FLAGS } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

// RP0-19: runs the EXACT example files (never copies) against the real app on
// a loopback listener and the isolated recovery PostgreSQL. Tokens are issued
// through the real POST /api/v1/api-tokens endpoint and revoked through the
// real DELETE /api/v1/api-tokens/{tokenId}.

const examplesDirectory = resolve(
  import.meta.dirname,
  "../../../../examples/recovery",
);
const CLIENTS = [
  {
    name: "bash + curl",
    command: resolve(examplesDirectory, "create-invoice.sh"),
  },
  { name: "python3", command: resolve(examplesDirectory, "create-invoice.py") },
] as const;

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const { cookieFor, call, scenario, addToGroup } = membershipFixtures({
  prisma,
  client,
  auth,
  app,
  url,
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  for (const tool of [
    ["python3", "--version"],
    ["curl", "--version"],
  ] as const) {
    const probe = spawnSync(tool[0], [tool[1]], { encoding: "utf8" });
    if (probe.status !== 0) {
      throw new Error(`${tool[0]} is required to run the client examples`);
    }
  }
  await client.connect();
  server = createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
  await client.end();
  await prisma.$disconnect();
});

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  stdin?: string;
  env?: Record<string, string>;
  /** Called with every sampled `ps` snapshot while the child is alive. */
  onProcessList?: (snapshot: string) => void;
}

function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        // CR-342: the Python client must not leave __pycache__ in examples/.
        PYTHONDONTWRITEBYTECODE: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    let sampling = false;
    const sampler = options.onProcessList
      ? setInterval(() => {
          if (sampling) return;
          sampling = true;
          let snapshot = "";
          const ps = spawn("ps", ["-axww", "-o", "args="]);
          ps.stdout.on("data", (chunk) => (snapshot += chunk));
          ps.on("close", () => {
            options.onProcessList?.(snapshot);
            sampling = false;
          });
        }, 10)
      : undefined;
    child.on("close", (status) => {
      if (sampler) clearInterval(sampler);
      done({ status, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
}

/** A member who may read and create, at organization and group scope. */
async function world() {
  const s = await scenario();
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: { ...NO_FLAGS, readInvoices: true, createInvoices: true },
  });
  await addToGroup(s.group.id, s.member.id, s.org.id, {
    readInvoices: true,
    createInvoices: true,
  });
  return { s, cookie: await cookieFor(s.member) };
}

async function issueToken(
  cookie: string,
  organizationId: string,
  groupId: string | null,
) {
  const response = await call("post", "/api-tokens", cookie, {
    name: `clients-${randomUUID()}`,
    organizationId,
    ...(groupId ? { groupId } : {}),
    scopes: ["invoices:read", "invoices:create"],
    expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
  });
  expect(response.status).toBe(201);
  return {
    id: response.body.token.id as string,
    secret: response.body.secret as string,
  };
}

const scopeArgs = (organizationId: string, groupId: string | null) => [
  "--base-url",
  baseUrl,
  "--organization-id",
  organizationId,
  ...(groupId ? ["--group-id", groupId] : []),
];

const invoiceIdOf = (output: string, step: string) =>
  new RegExp(`\\[${step}\\] HTTP \\d+ id=([0-9a-f-]{36})`).exec(output)?.[1];

function expectNoSecret(secret: string, ...outputs: string[]) {
  // Booleans only: a failure must not echo the bearer secret into the log.
  for (const output of outputs)
    expect(output.includes(secret), "client output carries the secret").toBe(
      false,
    );
}

describe.each(CLIENTS)("RP0-19 example client: $name", ({ command }) => {
  describe.each([
    { scope: "organization", grouped: false },
    { scope: "group", grouped: true },
  ])("$scope scope", ({ grouped }) => {
    it("creates, replays, conflicts, reads via Location and fails with 401 once revoked", async () => {
      const { s, cookie } = await world();
      const groupId = grouped ? s.group.id : null;
      const { id: tokenId, secret } = await issueToken(
        cookie,
        s.org.id,
        groupId,
      );
      const businessId = `FAC-${randomUUID()}`;
      const key = `clase-${randomUUID().replaceAll("-", "")}`;
      const seenProcesses: string[] = [];

      const created = await run(
        command,
        [
          "create",
          ...scopeArgs(s.org.id, groupId),
          "--business-id",
          businessId,
          "--idempotency-key",
          key,
        ],
        { stdin: `${secret}\n`, onProcessList: (ps) => seenProcesses.push(ps) },
      );

      expect(created.stderr).toBe("");
      expect(created.status).toBe(0);
      expect(seenProcesses.length).toBeGreaterThan(0);
      expectNoSecret(
        secret,
        created.stdout,
        created.stderr,
        seenProcesses.join("\n"),
      );
      const createdId = invoiceIdOf(created.stdout, "crear");
      expect(createdId).toBeDefined();
      expect(invoiceIdOf(created.stdout, "repetir")).toBe(createdId);
      expect(invoiceIdOf(created.stdout, "GET")).toBe(createdId);
      expect(created.stdout).toContain("replay=true");
      expect(created.stdout).toContain("[conflicto] HTTP 409");
      expect(created.stdout).toContain("monto=12500 CLP");

      const rows = await prisma.invoice.findMany({
        where: { organizationId: s.org.id, businessId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: createdId,
        groupId,
        amountPesos: 12500,
        currency: "CLP",
        createdByUserId: s.member.id,
      });

      const read = await run(
        command,
        [
          "get",
          ...scopeArgs(s.org.id, groupId),
          "--invoice-id",
          createdId as string,
        ],
        { stdin: `${secret}\n` },
      );
      expect(read.status).toBe(0);
      expect(invoiceIdOf(read.stdout, "GET")).toBe(createdId);
      expectNoSecret(secret, read.stdout, read.stderr);

      const revoked = await call("delete", `/api-tokens/${tokenId}`, cookie);
      expect(revoked.status).toBe(204);

      for (const args of [
        [
          "get",
          ...scopeArgs(s.org.id, groupId),
          "--invoice-id",
          createdId as string,
        ],
        ["create", ...scopeArgs(s.org.id, groupId)],
      ]) {
        const denied = await run(command, args, { stdin: `${secret}\n` });
        expect(denied.status).toBe(1);
        expect(denied.stderr).toContain("401 no autenticado");
        expectNoSecret(secret, denied.stdout, denied.stderr);
      }
      expect(
        await prisma.invoice.count({ where: { organizationId: s.org.id } }),
      ).toBe(1);
    });
  });

  it("reads the token from INVOICEOPS_TOKEN as well", async () => {
    const { s, cookie } = await world();
    const { secret } = await issueToken(cookie, s.org.id, null);

    const result = await run(
      command,
      ["create", ...scopeArgs(s.org.id, null)],
      {
        env: { INVOICEOPS_TOKEN: secret },
      },
    );

    expect(result.status).toBe(0);
    expectNoSecret(secret, result.stdout, result.stderr);
  });

  it("maps a missing scope to 403 without leaking the secret", async () => {
    const { s, cookie } = await world();
    const { secret } = await issueToken(cookie, s.org.id, null);
    const stranger = await scenario();

    const result = await run(
      command,
      ["create", ...scopeArgs(stranger.org.id, null)],
      { stdin: `${secret}\n` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^\[crear\] (403|404) /);
    expectNoSecret(secret, result.stdout, result.stderr);
    expect(s.org.id).not.toBe(stranger.org.id);
  });

  it("rejects non-loopback base URLs without any network attempt", async () => {
    let connections = 0;
    const proxy = createServer((_request, response) => {
      connections += 1;
      response.end();
    });
    proxy.on("connect", () => {
      connections += 1;
    });
    proxy.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const secret = `iop_${"A".repeat(43)}`;

    try {
      for (const remote of [
        "http://example.com",
        "https://example.com:8443",
        "http://127.0.0.1.example.com",
        "http://localhost@example.com",
        "http://192.168.1.10:4000",
      ]) {
        const result = await run(
          command,
          ["create", "--base-url", remote, "--organization-id", randomUUID()],
          {
            stdin: `${secret}\n`,
            env: {
              http_proxy: proxyUrl,
              HTTP_PROXY: proxyUrl,
              https_proxy: proxyUrl,
              HTTPS_PROXY: proxyUrl,
              ALL_PROXY: proxyUrl,
            },
          },
        );
        expect(result.status).toBe(3);
        expect(result.stderr).toContain("URL base rechazada");
        expectNoSecret(secret, result.stdout, result.stderr);
      }
      expect(connections).toBe(0);
    } finally {
      await new Promise((done) => proxy.close(done));
    }
  });

  it("keeps the idempotency key to retry after a timeout", async () => {
    const stalled = createServer(() => {
      // Never answers: the client must time out.
    });
    await new Promise<void>((done) => stalled.listen(0, "127.0.0.1", done));
    const stalledUrl = `http://127.0.0.1:${(stalled.address() as AddressInfo).port}`;
    const secret = `iop_${"B".repeat(43)}`;
    const key = `clase-${randomUUID().replaceAll("-", "")}`;

    try {
      const result = await run(
        command,
        [
          "create",
          "--base-url",
          stalledUrl,
          "--organization-id",
          randomUUID(),
          "--idempotency-key",
          key,
        ],
        { stdin: `${secret}\n`, env: { INVOICEOPS_TIMEOUT_SECONDS: "1" } },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(key);
      expect(result.stderr).toContain("MISMA clave");
      expectNoSecret(secret, result.stdout, result.stderr);
    } finally {
      stalled.closeAllConnections();
      await new Promise((done) => stalled.close(done));
    }
  });

  it.each([
    "not-a-uuid",
    "../../etc/passwd",
    "11111111-1111-4111-8111-11111111111",
    "11111111-1111-4111-8111-1111111111111",
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
    "11111111-1111-4111-8111-111111111111?x=1",
  ])(
    "rejects the malformed --invoice-id %j with a usage error before any request",
    async (invoiceId) => {
      let connections = 0;
      const probe = createServer((_request, response) => {
        connections += 1;
        response.end();
      });
      await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
      const probeUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
      const secret = `iop_${"C".repeat(43)}`;

      try {
        const result = await run(
          command,
          [
            "get",
            "--base-url",
            probeUrl,
            "--organization-id",
            randomUUID(),
            "--invoice-id",
            invoiceId,
          ],
          { stdin: `${secret}\n` },
        );
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("invoice-id");
        expect(connections).toBe(0);
        expectNoSecret(secret, result.stdout, result.stderr);
      } finally {
        await new Promise((done) => probe.close(done));
      }
    },
  );

  it.each(["abc", "1.5", "-3", "0"])(
    "rejects INVOICEOPS_TIMEOUT_SECONDS=%j with a usage error",
    async (timeout) => {
      const secret = `iop_${"D".repeat(43)}`;
      const result = await run(
        command,
        ["create", ...scopeArgs(randomUUID(), null)],
        { stdin: `${secret}\n`, env: { INVOICEOPS_TIMEOUT_SECONDS: timeout } },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("INVOICEOPS_TIMEOUT_SECONDS");
      expect(result.stderr).not.toContain("Traceback");
      expectNoSecret(secret, result.stdout, result.stderr);
    },
  );

  it("refuses a malformed token without printing it", async () => {
    const result = await run(
      command,
      ["create", ...scopeArgs(randomUUID(), null)],
      {
        stdin: "not-a-token\n",
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("not-a-token");
  });
});
