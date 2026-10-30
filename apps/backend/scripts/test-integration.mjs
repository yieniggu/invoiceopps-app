import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";

export const suites = ["test/organization-persistence.integration.test.ts"];

const migrations = resolve("prisma/migrations");
const baselineMigration = "20261026000000_initial_recovery_p0";
const schema = resolve("prisma/schema.prisma");
const image = "postgres:17-alpine";
const labelKey = "invoiceops.integration.owner";

function command(binary, args, options = {}, spawn = spawnSync) {
  const result = spawn(binary, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env,
  });
  if (result.error || result.status !== 0) {
    const phase = (options.stage ?? binary)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const cause =
      result.error?.code === "ETIMEDOUT"
        ? "timeout"
        : result.error
          ? "spawn-failed"
          : Number.isSafeInteger(result.status)
            ? `exit-${result.status}`
            : "process-failed";
    throw new Error(
      `${options.stage ?? binary} failed or timed out; cause=${cause}; phase=${phase}`,
    );
  }
  return result.stdout.trim();
}

function docker(args, env, stage, spawn) {
  return command("docker", args, { env, stage }, spawn);
}

function ownedId(name, nonce, env, spawn) {
  const result = spawn("docker", ["inspect", name, "--format", "{{json .}}"], {
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
  if (result.error) throw new Error("Container ownership inspection failed");
  if (result.status !== 0) {
    if (result.status === 1 && /No such object/.test(result.stderr))
      return null;
    throw new Error("Container ownership inspection failed");
  }
  const object = JSON.parse(result.stdout);
  if (
    object.Config?.Labels?.[labelKey] !== nonce ||
    !/^[a-f0-9]{64}$/.test(object.Id)
  ) {
    throw new Error(
      "Container ownership could not be verified; no cleanup attempted",
    );
  }
  return object.Id;
}

export function expectedMigrationChecksums(directory, names) {
  return names.map((name) => ({
    migration_name: name,
    checksum: createHash("sha256")
      .update(readFileSync(join(directory, name, "migration.sql")))
      .digest("hex"),
  }));
}

export function assertMigrationLedger(rows, expected) {
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        row.migration_name !== expected[index].migration_name ||
        row.checksum !== expected[index].checksum ||
        row.finished_at === null ||
        row.finished_at === undefined ||
        row.rolled_back_at !== null,
    )
  ) {
    throw new Error("Migration ledger name, checksum or status mismatch");
  }
}

async function migrate(directory, url, environment, stage, spawn) {
  const config = join(directory, "prisma.config.ts");
  writeFileSync(
    config,
    `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    { mode: 0o600 },
  );
  command(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", config],
    {
      env: { ...environment, DATABASE_URL: url },
      timeout: 180_000,
      stage,
    },
    spawn,
  );
}

function cleanupOwnedContainer(name, nonce, id, dockerEnv, spawn, log) {
  const owned = ownedId(name, nonce, dockerEnv, spawn);
  if (!owned) {
    if (id)
      throw new Error("Owned container missing before cleanup verification");
    return;
  }
  if (id && id !== owned)
    throw new Error("Container identity changed; refusing cleanup");
  docker(["rm", "--force", owned], dockerEnv, "owned container cleanup", spawn);
  if (ownedId(name, nonce, dockerEnv, spawn))
    throw new Error("Owned container still exists after cleanup");
  log("cleanup: exact owned container removed and absence verified");
}

export async function runIntegrationGate({
  argv = process.argv,
  env = process.env,
  spawn = spawnSync,
  Client = pg.Client,
  log = console.info,
} = {}) {
  if (
    argv.length !== 2 ||
    ["DATABASE_URL", "TEST_DATABASE_URL", "APP10_TEST_NAMESPACE"].some(
      (key) => env[key],
    )
  ) {
    throw new Error(
      "Integration gate rejects arguments and preconfigured database targets",
    );
  }
  const nonce = randomBytes(5).toString("hex");
  const name = `invoiceops-evi-${nonce}`;
  const password = randomBytes(32).toString("hex");
  const role = `evi_${nonce}`;
  const temp = mkdtempSync(join(tmpdir(), "invoiceops-evi-"));
  const baseEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  );
  const dockerEnv = {
    ...baseEnv,
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: join(temp, "docker-config"),
  };
  const child = {
    ...baseEnv,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    DOTENV_CONFIG_PATH: join(temp, "no-dotenv"),
    DOCKER_CONFIG: dockerEnv.DOCKER_CONFIG,
  };
  let id;
  try {
    mkdirSync(dockerEnv.DOCKER_CONFIG, { mode: 0o700 });
    log("stage: prisma-client-generation");
    command(
      "pnpm",
      ["run", "generate"],
      { env: child, timeout: 120_000, stage: "Prisma client generation" },
      spawn,
    );
    log("stage: local-image-preflight");
    docker(
      ["image", "inspect", image, "--format", "{{.Id}}"],
      dockerEnv,
      "local image preflight",
      spawn,
    );
    log("stage: local-socket-preflight");
    docker(
      ["info", "--format", "{{.ServerVersion}}"],
      dockerEnv,
      "local socket preflight",
      spawn,
    );
    const createEnv = {
      ...dockerEnv,
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: role,
      POSTGRES_DB: "invoiceops_test",
    };
    log("stage: isolated-create");
    docker(
      [
        "create",
        "--name",
        name,
        "--label",
        `${labelKey}=${nonce}`,
        "--pull=never",
        "--memory=512m",
        "--tmpfs",
        "/var/lib/postgresql/data:rw,size=512m",
        "-p",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_PASSWORD",
        "--env",
        "POSTGRES_USER",
        "--env",
        "POSTGRES_DB",
        image,
      ],
      createEnv,
      "isolated create",
      spawn,
    );
    id = ownedId(name, nonce, dockerEnv, spawn);
    if (!id) throw new Error("New container ownership unavailable");
    log("stage: isolated-start");
    docker(["start", id], dockerEnv, "isolated start", spawn);
    log("stage: loopback-port-verification");
    const port = JSON.parse(
      docker(
        ["inspect", id, "--format", "{{json .NetworkSettings.Ports}}"],
        dockerEnv,
        "port inspection",
        spawn,
      ),
    )["5432/tcp"]?.[0];
    if (port?.HostIp !== "127.0.0.1" || !/^\d+$/.test(port.HostPort))
      throw new Error("Loopback port verification failed");
    const url = `postgresql://${role}:${password}@127.0.0.1:${port.HostPort}/invoiceops_test`;
    let client;
    log("stage: postgres-readiness");
    const readyBy = Date.now() + 120_000;
    while (true) {
      const candidate = new Client({
        connectionString: url,
        connectionTimeoutMillis: 2000,
      });
      try {
        await candidate.connect();
        client = candidate;
        break;
      } catch {
        await candidate.end().catch(() => {});
        if (Date.now() >= readyBy)
          throw new Error("Isolated PostgreSQL readiness timed out");
        await delay(500);
      }
    }
    try {
      const names = readdirSync(migrations)
        .filter((entry) => /^\d{14}_/.test(entry))
        .sort();
      if (names[0] !== baselineMigration)
        throw new Error(`Expected ${baselineMigration} as the first migration`);
      const expectedLedger = expectedMigrationChecksums(migrations, names);
      log("stage: migrations");
      await migrate(temp, url, child, "migrations", spawn);
      const applied = await client.query(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      assertMigrationLedger(applied.rows, expectedLedger);
      const testEnv = {
        ...child,
        TEST_DATABASE_URL: url,
        APP10_TEST_NAMESPACE: nonce,
      };
      for (const [label, suite, expected] of [
        ["organization", suites[0], 24],
      ]) {
        const output = command(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            suite,
            "--testTimeout",
            "60000",
            "--hookTimeout",
            "120000",
          ],
          { env: testEnv, timeout: 300_000, stage: `${label} suite` },
          spawn,
        );
        const count = output.match(/Tests\s+(\d+) passed \((\d+)\)/);
        if (
          !count ||
          Number(count[1]) !== expected ||
          Number(count[2]) !== expected
        )
          throw new Error(
            `${label} suite did not pass all ${expected} expected cases`,
          );
        log(`stage: ${label} ${expected} passed`);
      }
    } finally {
      await client.end();
    }
  } finally {
    try {
      cleanupOwnedContainer(name, nonce, id, dockerEnv, spawn, log);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runIntegrationGate().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
