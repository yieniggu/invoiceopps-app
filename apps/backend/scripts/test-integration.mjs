import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
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

export const suites = [
  "test/evidence-persistence.integration.test.ts",
  "test/organization-persistence.integration.test.ts",
  "test/evidence-batches.integration.test.ts",
  "test/evidence-anchor-reservations.integration.test.ts",
  "test/evidence-anchor-transactions.integration.test.ts",
  "test/evidence-anchor-reconciliation.integration.test.ts",
  "test/evidence-anchor-cli.integration.test.ts",
];

const migrations = resolve("prisma/migrations");
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
    const diagnostic = `${result.stdout || ""}\n${result.stderr || ""}`;
    const smoke =
      options.stage === "owned Anvil smoke"
        ? diagnostic.match(
            /SMOKE_FAILURE step=[a-z0-9-]+ cause=(?:child-timeout|child-spawn-error|child-exit-nonzero|assertion-failed|child-process-failed) status=(?:-?\d+|none) signal=(?:SIG[A-Z]+|none) spawn_code=(?:E[A-Z]+|none) cli_phase=(?:input|database|execute|cleanup|none) cli_operation=(?:anchor|reconcile|command|none) cli_reason=(?:usage|authentication|configuration|database|data|operation|cleanup|none) phase=[a-z0-9-]+ method=(?:eth_[A-Za-z0-9]+|unknown)/,
          )?.[0]
        : undefined;
    throw new Error(
      `${options.stage ?? binary} failed or timed out; cause=${cause}; phase=${phase}${smoke ? `; ${smoke}` : ""}`,
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
    `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(directory === environment.fullDirectory ? migrations : join(directory, "migrations"))} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    { mode: 0o600 },
  );
  command(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", config],
    {
      env: { ...environment.child, DATABASE_URL: url },
      timeout: 180_000,
      stage,
    },
    spawn,
  );
}

async function seedLegacy(client) {
  const expected = {
    User: ["id", "name", "rut"],
    Organization: ["id", "name", "slug", "updatedAt"],
    Invoice: [
      "id",
      "invoiceId",
      "organizationId",
      "ownerType",
      "ownerId",
      "createdByUserId",
      "vendorName",
      "invoiceAmountCents",
      "hasPurchaseOrder",
      "threeWayMatch",
      "vendorTenureDays",
      "previousIncidents12m",
      "bankAccountRecentlyChanged",
      "amountVsVendorMedian",
      "countryRisk",
      "updatedAt",
    ],
    DecisionEvent: [
      "id",
      "invoiceId",
      "actorUserId",
      "actorName",
      "actorRut",
      "correlationId",
      "decision",
      "mode",
      "ruleVersion",
    ],
  };
  const columns = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(expected)],
  );
  for (const [table, required] of Object.entries(expected)) {
    const actual = columns.rows
      .filter((row) => row.table_name === table)
      .map((row) => row.column_name);
    if (
      required.some((column) => !actual.includes(column)) ||
      (table === "User" && actual.includes("updatedAt")) ||
      (table === "DecisionEvent" && actual.includes("updatedAt"))
    ) {
      throw new Error(`Legacy fixture schema preflight failed for ${table}`);
    }
  }
  const [organizationId, userId, invoiceId, eventId, correlationId] =
    Array.from({ length: 5 }, () => randomUUID());
  await client.query("BEGIN");
  try {
    await client.query(
      'INSERT INTO "Organization" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [
        organizationId,
        "Legacy evidence organization",
        `legacy-${organizationId}`,
      ],
    );
    await client.query(
      'INSERT INTO "User" ("id", "name", "rut") VALUES ($1, $2, $3)',
      [userId, "Legacy evidence actor", `legacy${userId.replaceAll("-", "")}`],
    );
    await client.query(
      `INSERT INTO "Invoice" ("id", "invoiceId", "organizationId", "ownerType", "ownerId", "createdByUserId", "vendorName", "invoiceAmountCents", "hasPurchaseOrder", "threeWayMatch", "vendorTenureDays", "previousIncidents12m", "bankAccountRecentlyChanged", "amountVsVendorMedian", "countryRisk", "updatedAt") VALUES ($1, $2, $3, 'USER', $4, $4, $5, 1, true, true, 1, 0, false, 1, 'low', CURRENT_TIMESTAMP)`,
      [
        invoiceId,
        `LEGACY-${invoiceId}`,
        organizationId,
        userId,
        "Legacy vendor",
      ],
    );
    await client.query(
      `INSERT INTO "DecisionEvent" ("id", "invoiceId", "actorUserId", "actorName", "actorRut", "correlationId", "decision", "mode", "ruleVersion") VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL_REVIEW', 'RULE_V1', 'invoice-rules-v1')`,
      [
        eventId,
        invoiceId,
        userId,
        "Legacy evidence actor",
        `legacy${userId.replaceAll("-", "")}`,
        correlationId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return eventId;
}

async function verifyAuditConstraintForwardCorrection(client, eventId) {
  await client.query(`ALTER TABLE "DecisionEvent"
    DROP CONSTRAINT "DecisionEvent_model_inference_snapshot_check",
    ADD CONSTRAINT "DecisionEvent_model_inference_snapshot_check" CHECK (
      ("policyProbabilitySource" = 'MODEL_API' AND "modelId" IS NOT NULL AND "modelVersion" IS NOT NULL AND "modelRunId" IS NOT NULL AND "policyProbability" IS NOT NULL AND "recommendation" IS NOT NULL)
      OR
      ("policyProbabilitySource" = 'MODEL_API_FALLBACK' AND "modelId" IS NULL AND "modelVersion" IS NULL AND "modelRunId" IS NULL AND "policyProbability" IS NULL AND "recommendation" = 'MANUAL_REVIEW')
      OR
      ("policyProbabilitySource" IS NULL AND "modelId" IS NULL AND "modelVersion" IS NULL AND "modelRunId" IS NULL AND "policyProbability" IS NULL AND "recommendation" IS NULL)
      OR
      ("policyProbabilitySource" = 'LOCAL_DEMONSTRATION')
    )`);

  const verifyUpdate = async (values, shouldReject, description) => {
    await client.query("BEGIN");
    let failure;
    try {
      const result = await client.query(
        `UPDATE "DecisionEvent"
         SET "policyProbabilitySource" = $2, "modelId" = $3, "modelVersion" = $4,
             "modelRunId" = $5, "policyProbability" = $6, "recommendation" = $7
         WHERE "id" = $1`,
        [eventId, ...values],
      );
      if (result.rowCount !== 1) {
        throw new Error("Audit guard fixture row was not updated");
      }
    } catch (error) {
      failure = error;
    }
    await client.query("ROLLBACK");

    if (shouldReject) {
      if (failure?.code !== "23514") {
        throw new Error(
          `Corrected audit constraint did not reject ${description}`,
        );
      }
    } else if (failure) {
      throw new Error(
        `Observed legacy audit constraint did not permit ${description}`,
      );
    }
  };

  await verifyUpdate(
    [null, "legacy-model", null, null, null, null],
    false,
    "a NULL-source partial snapshot before correction",
  );
  await verifyUpdate(
    ["LOCAL_DEMONSTRATION", "legacy-model", null, null, null, null],
    false,
    "a LOCAL_DEMONSTRATION snapshot with model metadata before correction",
  );

  return async () => {
    await verifyUpdate(
      [null, "legacy-model", null, null, null, null],
      true,
      "a NULL-source partial snapshot after correction",
    );
    await verifyUpdate(
      ["LOCAL_DEMONSTRATION", "legacy-model", null, null, null, null],
      true,
      "a LOCAL_DEMONSTRATION snapshot with model metadata after correction",
    );
  };
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
  ownedAnvil = null,
} = {}) {
  if (
    argv.length !== 2 ||
    [
      "DATABASE_URL",
      "TEST_DATABASE_URL",
      "APP10_TEST_NAMESPACE",
      "APP10_LEGACY_EVENT_ID",
    ].some((key) => env[key])
  ) {
    throw new Error(
      "Integration gate rejects arguments and preconfigured database targets",
    );
  }
  if (
    ownedAnvil !== null &&
    (!Number.isSafeInteger(ownedAnvil.pid) ||
      ownedAnvil.pid <= 0 ||
      !Number.isSafeInteger(ownedAnvil.port) ||
      ownedAnvil.port <= 0 ||
      ownedAnvil.port > 65535)
  )
    throw new Error("Invalid owned Anvil identity");
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
      const oldDirectory = join(temp, "baseline");
      mkdirSync(oldDirectory);
      const oldMigrations = join(oldDirectory, "migrations");
      mkdirSync(oldMigrations);
      for (const entry of readdirSync(migrations)) {
        if (
          entry === "migration_lock.toml" ||
          (/^\d{14}_/.test(entry) &&
            entry < "20261008060000_add_evidence_persistence")
        ) {
          cpSync(join(migrations, entry), join(oldMigrations, entry), {
            recursive: true,
          });
        }
      }
      const names = readdirSync(oldMigrations)
        .filter((entry) => /^\d{14}_/.test(entry))
        .sort();
      if (names.length !== 8)
        throw new Error("Expected exactly eight immutable baseline migrations");
      const expectedBaseline = expectedMigrationChecksums(migrations, names);
      const copied = expectedMigrationChecksums(oldMigrations, names);
      if (
        copied.some(
          (row, index) => row.checksum !== expectedBaseline[index].checksum,
        )
      )
        throw new Error("Baseline migration copy differs from source");
      const environment = { child, fullDirectory: join(temp, "full") };
      mkdirSync(environment.fullDirectory);
      log("stage: baseline-migrations");
      await migrate(
        oldDirectory,
        url,
        environment,
        "baseline migrations",
        spawn,
      );
      const applied = await client.query(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      assertMigrationLedger(applied.rows, expectedBaseline);
      log("stage: seed-legacy-transaction");
      const legacyId = await seedLegacy(client);
      log("stage: migrations-9-13");
      const verifyCorrectedAuditConstraint =
        await verifyAuditConstraintForwardCorrection(client, legacyId);
      await migrate(
        environment.fullDirectory,
        url,
        environment,
        "Evidence and audit-guard migrations",
        spawn,
      );
      const after = await client.query(
        'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      const evidenceName = "20261008060000_add_evidence_persistence";
      assertMigrationLedger(after.rows, [
        ...expectedBaseline,
        ...expectedMigrationChecksums(migrations, [
          evidenceName,
          "20261011000000_add_evidence_anchor_reservations",
          "20261011010000_add_evidence_prepared_transactions",
          "20261011020000_add_evidence_anchor_observations",
          "20261013000000_correct_model_inference_snapshot_guard",
        ]),
      ]);
      await verifyCorrectedAuditConstraint();
      const legacy = await client.query(
        'SELECT count(*)::int AS total FROM "EvidenceRecord" WHERE "decisionEventId" = $1',
        [legacyId],
      );
      if (legacy.rows[0].total !== 0)
        throw new Error("Migration unexpectedly backfilled legacy Evidence");
      const testEnv = {
        ...child,
        TEST_DATABASE_URL: url,
        APP10_TEST_NAMESPACE: nonce,
        APP10_LEGACY_EVENT_ID: legacyId,
      };
      for (const [label, suite, expected] of [
        ["SQL", suites[0], 10],
        ["organization", suites[1], 31],
        ["batch", suites[2], 7],
        ["reservation", suites[3], 6],
        ["transaction", suites[4], 4],
        ["reconciliation", suites[5], 2],
        ["CLI authorization", suites[6], 4],
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
      if (ownedAnvil !== null) {
        const output = command(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "test/evidence-anchor-anvil.integration.test.ts",
            "--testTimeout",
            "60000",
            "--hookTimeout",
            "120000",
          ],
          {
            env: {
              ...testEnv,
              APP11_OWN_ANVIL_PID: String(ownedAnvil.pid),
              APP11_OWN_ANVIL_PORT: String(ownedAnvil.port),
            },
            timeout: 180_000,
            stage: "owned Anvil smoke",
          },
          spawn,
        );
        if (!/Tests\s+1 passed \(1\)/.test(output))
          throw new Error(
            "Owned Anvil smoke did not pass its one expected case",
          );
        log("stage: owned Anvil smoke 1 passed");
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
