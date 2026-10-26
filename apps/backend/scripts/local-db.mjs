import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceContainer = "invoiceops-local-app-db-1";
const containerName = "invoiceops-app-dev-db-1";
const volumeName = "invoiceops-app-dev_postgres_data";
const ownerLabel = "invoiceops.localdb.owner";
const ownerValue = "invoiceops-app-managed-local-db-v1";
const projectLabel = "invoiceops.localdb.project";
const projectValue = "invoiceops-app";
const targetPort = "5546";
const databaseName = "invoiceops";
const databaseRole = "invoiceops";
const expectedUserId = "0020d283-ff30-47f2-8c4c-4eb6e8f0da81";
const expectedOrganizationId = "4fa41bfa-e5d7-4e0b-b68d-b2ba1efcce84";
const legacyTables = [
  "User",
  "Organization",
  "OrganizationMembership",
  "Group",
  "GroupMembership",
  "AuthorizedUserOrganization",
  "Session",
  "ResourceReference",
  "Invoice",
  "BusinessPolicy",
  "DecisionEvent",
  "PlatformAdministrator",
  "PlatformAdministrativeAuditEvent",
];
const newTables = [
  "EvidenceRecord",
  "EvidenceBatch",
  "EvidenceBatchItem",
  "EvidenceAnchorReservation",
  "EvidenceSignerPreparationSlot",
  "EvidencePreparedAnchorTransaction",
  "EvidenceAnchorObservation",
];

function canonicalDecisionEventGuardPredicate() {
  const migrationRoot = join(backend, "prisma", "migrations");
  let predicate;
  for (const migration of readdirSync(migrationRoot)
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort()) {
    const sql = readFileSync(
      join(migrationRoot, migration, "migration.sql"),
      "utf8",
    );
    const match = sql.match(
      /ADD CONSTRAINT "DecisionEvent_model_inference_snapshot_check" CHECK \(([\s\S]*?)\);/,
    );
    if (match) predicate = match[1];
  }
  if (!predicate) {
    fail("Canonical DecisionEvent audit guard is missing from migrations");
  }
  return predicate;
}

const decisionEventGuardPredicate = canonicalDecisionEventGuardPredicate();
export const sourceInventorySql = `SELECT json_build_object(
  'database', current_database(),
  'role', current_user,
  'pid', pg_backend_pid(),
  'users', (SELECT count(*) FROM "User"),
  'organizations', (SELECT count(*) FROM "Organization"),
  'memberships', (SELECT count(*) FROM "OrganizationMembership"),
  'invoices', (SELECT count(*) FROM "Invoice"),
  'decisions', (SELECT count(*) FROM "DecisionEvent"),
  'policies', (SELECT count(*) FROM "BusinessPolicy"),
  'sessions', (SELECT count(*) FROM "Session"),
  'guardViolationCount', (SELECT count(*) FROM "DecisionEvent" WHERE NOT (${decisionEventGuardPredicate}))
  , 'guardViolationSample', (SELECT coalesce(json_agg(json_build_object('id', id, 'mode', mode) ORDER BY id), '[]'::json) FROM (SELECT id, mode FROM "DecisionEvent" WHERE NOT (${decisionEventGuardPredicate}) ORDER BY id LIMIT 5) AS violations)
)`;
export const sourceCatalogSql = `SELECT json_build_object(
  'database', current_database(),
  'role', current_user,
  'nonSystemRelationCount', (
    SELECT count(*)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      AND namespace.nspname !~ '^pg_(toast|temp)_'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  )
)`;

function fail(message) {
  throw new Error(message);
}

function safeChildEnvironment(extra = {}) {
  const environment = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...extra };
}

function processFailure(result, phase, diagnostic) {
  const cause =
    result.error?.code === "ETIMEDOUT"
      ? "timeout"
      : result.error
        ? `spawn-${String(result.error.code ?? "failed").toLowerCase()}`
        : Number.isSafeInteger(result.status)
          ? `exit-${result.status}`
          : "process-failed";
  fail(
    `${phase} failed (${cause}${diagnostic ? `; ${diagnostic}` : ""}); no automatic retry was attempted`,
  );
}

export function safeProcessDiagnostic(stderr) {
  for (const line of String(stderr ?? "")
    .trim()
    .split("\n")
    .reverse()) {
    try {
      const value = JSON.parse(line);
      if (value?.diagnostic === "native-profile-proof-failed") {
        const status = [400, 401, 403, 404, 409].includes(value.status)
          ? `auth-status-${value.status}`
          : undefined;
        const code =
          typeof value.code === "string" &&
          /^(?:ERR_[A-Z0-9_]+|P\d{4})$/.test(value.code)
            ? `runtime-code-${value.code}`
            : undefined;
        const sessionState =
          value.status === 401 &&
          typeof value.sessionFound === "boolean" &&
          typeof value.sessionActive === "boolean" &&
          typeof value.sessionOwnerMatches === "boolean"
            ? `session-found-${value.sessionFound}-active-${value.sessionActive}-owner-${value.sessionOwnerMatches}`
            : undefined;
        return (
          [status, code, sessionState].filter(Boolean).join(" ") ||
          "profile-proof-rejected"
        );
      }
      if (value?.diagnostic === "native-profile-proof-disconnect-failed") {
        return value.diagnostic;
      }
    } catch {
      // Tool output and stack traces are intentionally ignored.
    }
  }
  return undefined;
}

function run(
  binary,
  args,
  {
    env,
    input,
    encoding = "utf8",
    maxBuffer = 8 * 1024 * 1024,
    timeout = 20_000,
    phase,
    safeDiagnostic = false,
  },
) {
  const result = spawnSync(binary, args, {
    cwd: backend,
    encoding,
    env,
    input,
    maxBuffer,
    timeout,
  });
  if (result.error || result.status !== 0) {
    processFailure(
      result,
      phase,
      safeDiagnostic ? safeProcessDiagnostic(result.stderr) : undefined,
    );
  }
  return result.stdout;
}

function ensurePrivateStateDirectory() {
  const home = homedir();
  const homeStat = lstatSync(home);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    homeStat.uid !== process.getuid()
  ) {
    fail("Home directory ownership check failed");
  }
  const directory = join(home, ".invoiceops-app-local");
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    fail(
      "Private local metadata directory must be an owned mode-0700 directory",
    );
  }
  return directory;
}

function dockerCall(
  args,
  {
    env,
    input,
    encoding = "utf8",
    maxBuffer = 8 * 1024 * 1024,
    timeout = 20_000,
    phase,
  },
) {
  return run("docker", ["--host", "unix:///var/run/docker.sock", ...args], {
    env,
    input,
    encoding,
    maxBuffer,
    timeout,
    phase,
  });
}

async function probeManagedPostgres(databaseUrl) {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_500,
    query_timeout: 2_500,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("SELECT 1");
  } finally {
    if (connected) await client.end();
  }
}

function isTransientManagedPostgresReadinessError(error) {
  if (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P03"].includes(error?.code)
  ) {
    return true;
  }
  return (
    error?.code === undefined &&
    [
      "Connection terminated unexpectedly",
      "Client has encountered a connection error and is not queryable",
      "Query read timeout",
      "timeout expired",
    ].includes(error?.message)
  );
}

export function safeManagedPostgresReadinessDiagnostic(error) {
  const errorName =
    error?.name === "Error" || error?.name === "DatabaseError"
      ? error.name.toLowerCase()
      : "unknown";
  const code =
    error?.code === undefined
      ? "absent"
      : ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code)
        ? "present-network"
        : typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
          ? "present-postgresql"
          : typeof error?.code === "string"
            ? "present-unrecognized"
            : "present-nonstring";
  const message =
    error?.message === "Connection terminated unexpectedly"
      ? "connection-terminated"
      : error?.message ===
          "Client has encountered a connection error and is not queryable"
        ? "client-not-queryable"
        : error?.message === "Query read timeout"
          ? "query-timeout"
          : error?.message === "timeout expired"
            ? "connection-timeout"
            : error?.message === "password authentication failed for user"
              ? "authentication-failed"
              : "unclassified";
  return `error-name-${errorName} code-${code} message-${message}`;
}

export async function waitForManagedPostgres(
  databaseUrl,
  { probe = probeManagedPostgres, sleep = delay, report = console.warn } = {},
) {
  const deadline = Date.now() + 30_000;
  let lastDiagnostic;
  while (Date.now() < deadline) {
    try {
      await probe(databaseUrl);
      return;
    } catch (error) {
      const diagnostic = safeManagedPostgresReadinessDiagnostic(error);
      if (!isTransientManagedPostgresReadinessError(error)) {
        fail(
          `managed PostgreSQL readiness probe failed (${diagnostic}); no automatic retry was attempted`,
        );
      }
      lastDiagnostic = diagnostic;
      report(`managed PostgreSQL readiness retry (${diagnostic})`);
    }
    await sleep(500);
  }
  fail(
    `Managed PostgreSQL readiness did not complete within 30 seconds (${lastDiagnostic ?? "no-readiness-diagnostic"}); migrations were not started`,
  );
}

function dockerInspect(args, env, phase) {
  const isVolume = args.includes("volume");
  const format = isVolume
    ? "{{.Name}}\n{{json .Labels}}\n{{.Driver}}"
    : "{{.Id}}\n{{.Name}}\n{{.Image}}\n{{json .State}}\n{{json .Config.Labels}}\n{{json .Mounts}}\n{{json .HostConfig.PortBindings}}\n{{json .NetworkSettings.Ports}}";
  const inspectArgs = isVolume
    ? ["inspect", "--type", "volume", "--format", format, args.at(-1)]
    : ["inspect", "--format", format, ...args];
  const result = spawnSync(
    "docker",
    ["--host", "unix:///var/run/docker.sock", ...inspectArgs],
    {
      cwd: backend,
      encoding: "utf8",
      env,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (
    result.status === 1 &&
    /No such (object|volume)/i.test(result.stderr ?? "")
  ) {
    return null;
  }
  if (result.error || result.status !== 0) processFailure(result, phase);
  const lines = result.stdout.trimEnd().split("\n");
  if (isVolume) {
    return [{ Name: lines[0], Labels: JSON.parse(lines[1]), Driver: lines[2] }];
  }
  return [
    {
      Id: lines[0],
      Name: lines[1],
      Image: lines[2],
      State: JSON.parse(lines[3]),
      Config: { Labels: JSON.parse(lines[4]) },
      Mounts: JSON.parse(lines[5]),
      HostConfig: { PortBindings: JSON.parse(lines[6]) },
      NetworkSettings: { Ports: JSON.parse(lines[7]) },
    },
  ];
}

function verifyManagedVolume(env) {
  const volume = dockerInspect(
    ["--type", "volume", volumeName],
    env,
    "managed volume inspection",
  )?.[0];
  if (
    volume &&
    (volume.Driver !== "local" ||
      volume.Labels?.[ownerLabel] !== ownerValue ||
      volume.Labels?.[projectLabel] !== projectValue)
  ) {
    fail(
      "Named volume exists without the expected manager labels; refusing adoption",
    );
  }
  if (!volume) {
    dockerCall(
      [
        "volume",
        "create",
        "--label",
        `${ownerLabel}=${ownerValue}`,
        "--label",
        `${projectLabel}=${projectValue}`,
        volumeName,
      ],
      { env, phase: "managed volume creation" },
    );
    return;
  }
}

function cleanupManagedClone(container, dockerEnv) {
  const verifiedContainer = verifyManagedContainer(
    dockerInspect([containerName], dockerEnv, "managed clone cleanup preflight"),
  );
  if (!verifiedContainer || verifiedContainer.Id !== container.Id) {
    fail("Managed clone identity changed before cleanup; refusing removal");
  }
  const verifiedVolume = dockerInspect(
    ["--type", "volume", volumeName],
    dockerEnv,
    "managed clone volume cleanup preflight",
  )?.[0];
  if (
    !verifiedVolume ||
    verifiedVolume.Driver !== "local" ||
    verifiedVolume.Labels?.[ownerLabel] !== ownerValue ||
    verifiedVolume.Labels?.[projectLabel] !== projectValue
  ) {
    fail("Managed clone volume identity changed before cleanup; refusing removal");
  }
  dockerCall(["rm", "--force", verifiedContainer.Id], {
    env: dockerEnv,
    phase: "managed clone container cleanup",
  });
  if (dockerInspect([containerName], dockerEnv, "managed clone absence check")) {
    fail("Managed clone container still exists after cleanup");
  }
  dockerCall(["volume", "rm", volumeName], {
    env: dockerEnv,
    phase: "managed clone volume cleanup",
  });
  if (
    dockerInspect(
      ["--type", "volume", volumeName],
      dockerEnv,
      "managed clone volume absence check",
    )
  ) {
    fail("Managed clone volume still exists after cleanup");
  }
}

function verifySourceContainer(source) {
  if (
    !source ||
    source.State?.Status !== "running" ||
    source.Config?.Labels?.["com.docker.compose.project"] !==
      "invoiceops-local-app" ||
    source.Config?.Labels?.["com.docker.compose.service"] !== "db" ||
    !source.Mounts?.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === "invoiceops-local-app_postgres_data" &&
        mount.Destination === "/var/lib/postgresql/data",
    )
  ) {
    fail(
      "Selected source database identity did not match the approved local container and volume",
    );
  }
  return source;
}

function cleanupManagedMetadata(stateDirectory, metadata, container) {
  if (!metadata) return;
  if (
    metadata.target?.container !== containerName ||
    metadata.target?.containerId !== container.Id ||
    metadata.target?.volume !== volumeName ||
    metadata.target?.port !== Number(targetPort)
  ) {
    fail("Managed clone metadata identity changed before cleanup; refusing removal");
  }
  if (metadata.session?.sessionId && metadata.session?.tokenFile) {
    const tokenPath = verifiedSessionTokenPath(
      stateDirectory,
      metadata.session.sessionId,
      metadata.session.tokenFile,
    );
    rmSync(tokenPath, { force: true });
    rmdirSync(dirname(tokenPath));
  }
  rmSync(join(stateDirectory, "local-db.json"), { force: true });
}

export function verifyManagedContainer(container) {
  if (!container) return null;
  const object = container[0];
  const inspectedName = object.Name?.replace(/^\//, "");
  const mount = object.Mounts?.find(
    (item) => item.Destination === "/var/lib/postgresql/data",
  );
  const port =
    object.NetworkSettings?.Ports?.["5432/tcp"]?.[0] ??
    object.HostConfig?.PortBindings?.["5432/tcp"]?.[0];
  if (
    inspectedName !== containerName ||
    object.Config?.Labels?.[ownerLabel] !== ownerValue ||
    object.Config?.Labels?.[projectLabel] !== projectValue ||
    mount?.Type !== "volume" ||
    mount.Name !== volumeName ||
    port?.HostIp !== "127.0.0.1" ||
    port.HostPort !== targetPort ||
    !/^[a-f0-9]{64}$/.test(object.Id)
  ) {
    fail(
      "Managed container identity, labels, volume, or loopback port mismatch; refusing use",
    );
  }
  return object;
}

function readNewOwnedPassword(container, dockerEnv) {
  // This is the only secret read: the target container has already passed exact owner, volume, and loopback checks.
  const value = dockerCall(
    ["inspect", container.Id, "--format", "{{json .Config.Env}}"],
    { env: dockerEnv, phase: "owned target credential retrieval" },
  );
  const variables = JSON.parse(value);
  const password = variables
    .find((entry) => entry.startsWith("POSTGRES_PASSWORD="))
    ?.slice("POSTGRES_PASSWORD=".length);
  if (!password || password.length < 40)
    fail("Owned target credential is missing or invalid");
  return password;
}

function expectedMigrations() {
  const migrationRoot = join(backend, "prisma", "migrations");
  return readdirSync(migrationRoot)
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort()
    .map((name) => ({
      name,
      checksum: createHash("sha256")
        .update(readFileSync(join(migrationRoot, name, "migration.sql")))
        .digest("hex"),
    }));
}

export function verifyMigrationRows(rows, expected) {
  if (
    rows.length !== expected.length ||
    rows.some(
      (row, index) =>
        row.migration_name !== expected[index].name ||
        row.checksum !== expected[index].checksum ||
        !row.finished_at ||
        row.rolled_back_at,
    )
  ) {
    fail(
      "Target Prisma migration ledger does not match the checked-out canonical migration set",
    );
  }
}

function migrationConfig(tempDirectory) {
  const configPath = join(tempDirectory, "prisma.config.ts");
  const schema = join(backend, "prisma", "schema.prisma");
  const migrations = join(backend, "prisma", "migrations");
  writeFileSync(
    configPath,
    `export default { schema: ${JSON.stringify(schema)}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`,
    { mode: 0o600, flag: "wx" },
  );
  return configPath;
}

function psqlSource(sql, dockerEnv, phase) {
  const output = dockerCall(
    [
      "exec",
      "-e",
      "PGPASSFILE=/dev/null",
      "-e",
      "PGCONNECT_TIMEOUT=3",
      "-e",
      "PGOPTIONS=-c statement_timeout=3000 -c lock_timeout=1000",
      sourceContainer,
      "psql",
      "-X",
      "-w",
      "-h",
      "/var/run/postgresql",
      "-p",
      "5432",
      "-U",
      databaseRole,
      "-d",
      databaseName,
      "-At",
      "-c",
      sql,
    ],
    { env: dockerEnv, phase, timeout: 10_000 },
  );
  return JSON.parse(output.trim());
}

function tableFingerprintSql(excludedSessionId) {
  if (
    excludedSessionId !== undefined &&
    !/^[0-9a-f-]{36}$/i.test(excludedSessionId)
  ) {
    fail("Invalid session identity in local metadata");
  }
  return `SELECT json_agg(json_build_object('table', name, 'rows', row_count, 'hash', digest) ORDER BY name) FROM (
    ${legacyTables
      .map((table) => {
        const rowJson =
          table === "User"
            ? "to_jsonb(t) - 'mustChangePassword' - 'temporaryPasswordExpiresAt'"
            : "to_jsonb(t)";
        return `SELECT '${table}'::text AS name, count(*)::bigint AS row_count, md5(coalesce(string_agg((${rowJson})::text, E'\\n' ORDER BY to_jsonb(t)->>'id'), '')) AS digest FROM "${table}" AS t${table === "Session" && excludedSessionId ? ` WHERE t.id <> '${excludedSessionId}'` : ""}`;
      })
      .join(" UNION ALL ")}
  ) AS fingerprints`;
}

export function isCleanBootstrapCandidate(
  legacySnapshot,
  evidenceTableCounts,
  targetRelations,
) {
  const expectedTargetRelations = canonicalTargetRelations();
  return (
    Array.isArray(legacySnapshot) &&
    Array.isArray(evidenceTableCounts) &&
    Array.isArray(targetRelations) &&
    legacySnapshot.length === legacyTables.length &&
    evidenceTableCounts.length === newTables.length &&
    targetRelations.length === expectedTargetRelations.length &&
    legacySnapshot.every(
      (row) =>
        typeof row?.table === "string" &&
        legacyTables.includes(row.table) &&
        Number(row.rows) === 0 &&
        typeof row.hash === "string" &&
        /^[a-f0-9]{32}$/.test(row.hash),
    ) &&
    new Set(legacySnapshot.map((row) => row.table)).size ===
      legacyTables.length &&
    evidenceTableCounts.every((count) => Number(count) === 0) &&
    targetRelations.every(
      (relation, index) =>
        relation?.name === expectedTargetRelations[index].name &&
        relation?.kind === expectedTargetRelations[index].kind,
    )
  );
}

function canonicalTargetRelations() {
  return ["_prisma_migrations", ...legacyTables, ...newTables]
    .sort()
    .map((name) => ({ name, kind: "r" }));
}

export function isVerifiedCleanSourceCatalog(source) {
  return (
    source?.database === databaseName &&
    source?.role === databaseRole &&
    Number(source?.nonSystemRelationCount) === 0
  );
}

export function compareFingerprints(source, target) {
  if (
    source.length !== target.length ||
    source.some(
      (row, index) =>
        row.table !== target[index].table ||
        Number(row.rows) !== Number(target[index].rows) ||
        row.hash !== target[index].hash,
    )
  ) {
    fail(
      "Source and managed target aggregate row fingerprints differ; no source rows were removed or rewritten",
    );
  }
}

export function isSessionExpired(expiresAt, now = new Date()) {
  return expiresAt <= now;
}

export function sessionExpiryParameter(value) {
  const expiresAt = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(expiresAt.getTime())) {
    fail("Invalid local session expiry");
  }
  return expiresAt.toISOString();
}

async function getTargetFingerprint(client) {
  const result = await client.query(tableFingerprintSql());
  return result.rows[0].json_agg;
}

async function countTargetRows(client, names) {
  const result = await client.query(
    `SELECT ${names.map((name, index) => `(SELECT count(*)::int FROM "${name}") AS "c${index}"`).join(", ")}`,
  );
  return names.map((_, index) => Number(result.rows[0][`c${index}`]));
}

async function verifyNewTablesEmpty(client) {
  const counts = await countTargetRows(client, newTables);
  if (counts.some((count) => count !== 0))
    fail("Fresh evidence/anchor tables are unexpectedly non-empty");
  return counts;
}

export async function getTargetRelations(client) {
  const result = await client.query(
    `SELECT relname AS name, relkind AS kind FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') ORDER BY relname, relkind`,
  );
  return result.rows;
}

export async function verifyAuditGuard(client, requireBehavioralProbe = true) {
  const constraint = await client.query(
    `SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"DecisionEvent"'::regclass AND conname = 'DecisionEvent_model_inference_snapshot_check'`,
  );
  if (
    constraint.rowCount !== 1 ||
    !constraint.rows[0].convalidated ||
    !constraint.rows[0].definition.includes("COALESCE")
  ) {
    fail(
      "Corrected model-inference check constraint is absent, unvalidated, or missing NULL rejection",
    );
  }
  const ids = await client.query(
    `SELECT id FROM "DecisionEvent" ORDER BY id LIMIT 1`,
  );
  if (ids.rowCount !== 1) {
    if (requireBehavioralProbe) {
      fail(
        "Expected existing decision row is unavailable for native constraint proof",
      );
    }
    return;
  }
  for (const patch of [
    `SET "policyProbabilitySource" = NULL, "modelId" = 'guard-probe'`,
    `SET "policyProbabilitySource" = 'LOCAL_DEMONSTRATION', "modelId" = 'guard-probe'`,
  ]) {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL statement_timeout = '3s'");
    await client.query("SAVEPOINT guard_probe");
    let rejected = false;
    try {
      await client.query(`UPDATE "DecisionEvent" ${patch} WHERE id = $1`, [
        ids.rows[0].id,
      ]);
    } catch (error) {
      if (
        error.code !== "23514" ||
        error.constraint !== "DecisionEvent_model_inference_snapshot_check"
      ) {
        throw new Error(
          "Audit constraint proof failed with an unexpected database error",
        );
      }
      rejected = true;
    }
    await client.query("ROLLBACK TO SAVEPOINT guard_probe");
    await client.query("ROLLBACK");
    if (!rejected)
      fail(
        "Corrected model-inference guard accepted an invalid native SQL update",
      );
  }
}

function sourceDump(dockerEnv) {
  return dockerCall(
    [
      "exec",
      "-e",
      "PGPASSFILE=/dev/null",
      "-e",
      "PGCONNECT_TIMEOUT=3",
      "-e",
      "PGOPTIONS=-c statement_timeout=3000 -c lock_timeout=1000",
      sourceContainer,
      "pg_dump",
      "-w",
      "-h",
      "/var/run/postgresql",
      "-p",
      "5432",
      "-U",
      databaseRole,
      "-d",
      databaseName,
      "-Fc",
      "--data-only",
      "--exclude-table=public._prisma_migrations",
    ],
    {
      env: dockerEnv,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      phase: "source data-only dump",
    },
  );
}

function sessionHash(token) {
  return createHash("sha256").update(token).digest("base64");
}

function ensureRegularPrivateFile(path) {
  const info = lstatSync(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0
  ) {
    fail("Private session artifact must be an owned mode-0600 regular file");
  }
}

function verifiedSessionTokenPath(stateDirectory, sessionId, tokenPath) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    fail("Invalid session identity in local metadata");
  }
  const artifactDirectory = join(stateDirectory, `session-${sessionId}`);
  const directoryInfo = lstatSync(artifactDirectory);
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    directoryInfo.uid !== process.getuid() ||
    (directoryInfo.mode & 0o077) !== 0
  ) {
    fail("Session artifact directory must be owned and mode 0700");
  }
  const expectedPath = join(artifactDirectory, "session-token.txt");
  if (tokenPath !== expectedPath) {
    fail("Session artifact path is outside its managed directory");
  }
  ensureRegularPrivateFile(expectedPath);
  return expectedPath;
}

function createSessionArtifact(stateDirectory, sessionId, token) {
  const artifactDirectory = join(stateDirectory, `session-${sessionId}`);
  mkdirSync(artifactDirectory, { mode: 0o700 });
  const tokenPath = join(artifactDirectory, "session-token.txt");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(artifactDirectory, 0o700);
  ensureRegularPrivateFile(tokenPath);
  return tokenPath;
}

async function ensureSession(client, stateDirectory, metadata, profileEnv) {
  if (metadata.session?.sessionId && metadata.session?.tokenFile) {
    const tokenPath = verifiedSessionTokenPath(
      stateDirectory,
      metadata.session.sessionId,
      metadata.session.tokenFile,
    );
    const token = readFileSync(tokenPath, "utf8").trim();
    let stored = await client.query(
      `SELECT "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt" FROM "Session" WHERE id = $1 AND "tokenHash" = $2 AND "userId" = $3`,
      [metadata.session.sessionId, sessionHash(token), expectedUserId],
    );
    if (
      stored.rowCount === 0 &&
      !isSessionExpired(new Date(metadata.session.expiresAt))
    ) {
      await client.query(
        `INSERT INTO "Session" (id, "tokenHash", "userId", "expiresAt") VALUES ($1, $2, $3, $4::timestamptz AT TIME ZONE 'UTC') ON CONFLICT (id) DO NOTHING`,
        [
          metadata.session.sessionId,
          sessionHash(token),
          expectedUserId,
          sessionExpiryParameter(metadata.session.expiresAt),
        ],
      );
      stored = await client.query(
        `SELECT "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt" FROM "Session" WHERE id = $1 AND "tokenHash" = $2 AND "userId" = $3`,
        [metadata.session.sessionId, sessionHash(token), expectedUserId],
      );
    }
    if (stored.rowCount !== 1) {
      fail(
        "Recorded local session artifact does not match its database row; refusing to issue a replacement",
      );
    }
    if (!isSessionExpired(stored.rows[0].expiresAt)) {
      try {
        await verifyAuthProfile(token, metadata, profileEnv);
      } catch (error) {
        if (!error.provesSessionInvalidation) throw error;
        return rotateExpiredSession(
          client,
          stateDirectory,
          metadata,
          profileEnv,
          metadata.session,
          tokenPath,
          true,
        );
      }
      return { session: metadata.session, tokenPath };
    }
    return rotateExpiredSession(
      client,
      stateDirectory,
      metadata,
      profileEnv,
      metadata.session,
      tokenPath,
      false,
    );
  }
  return createVerifiedSession(client, stateDirectory, metadata, profileEnv);
}

async function createVerifiedSession(
  client,
  stateDirectory,
  metadata,
  profileEnv,
) {
  const token = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const tokenPath = createSessionArtifact(stateDirectory, sessionId, token);
  const session = {
    sessionId,
    expiresAt: expiresAt.toISOString(),
    tokenFile: tokenPath,
  };
  await client.query(
    `INSERT INTO "Session" (id, "tokenHash", "userId", "expiresAt") VALUES ($1, $2, $3, $4::timestamptz AT TIME ZONE 'UTC')`,
    [
      sessionId,
      sessionHash(token),
      expectedUserId,
      sessionExpiryParameter(expiresAt),
    ],
  );
  try {
    await verifyAuthProfile(token, metadata, profileEnv);
  } catch (error) {
    await client.query(
      `DELETE FROM "Session" WHERE id = $1 AND "tokenHash" = $2 AND "userId" = $3`,
      [sessionId, sessionHash(token), expectedUserId],
    );
    rmSync(tokenPath);
    rmdirSync(dirname(tokenPath));
    throw error;
  }
  metadata.session = session;
  writeMetadata(stateDirectory, metadata);
  return { session, tokenPath };
}

async function rotateExpiredSession(
  client,
  stateDirectory,
  metadata,
  profileEnv,
  expiredSession,
  expiredTokenPath,
  invalidationProof = false,
) {
  const replacement = await createVerifiedSession(
    client,
    stateDirectory,
    metadata,
    profileEnv,
  );
  const revoked = await client.query(
    `DELETE FROM "Session" WHERE id = $1 AND "tokenHash" = $2 AND "userId" = $3 AND ($4::boolean OR "expiresAt" <= ($5::timestamptz AT TIME ZONE 'UTC'))`,
    [
      expiredSession.sessionId,
      sessionHash(readFileSync(expiredTokenPath, "utf8").trim()),
      expectedUserId,
      invalidationProof,
      sessionExpiryParameter(new Date()),
    ],
  );
  if (revoked.rowCount !== 1) {
    fail(
      "Verified replacement session was created, but the owned prior session could not be revoked",
    );
  }
  rmSync(expiredTokenPath);
  rmdirSync(dirname(expiredTokenPath));
  return replacement;
}

export function nativeProfileProofSource() {
  return `void (async () => { let db; let sessionState; try { const [{ createAuthService }, { createDatabase }] = await Promise.all([import('./src/auth.ts'), import('./src/database.ts')]); const { createHash } = await import('node:crypto'); db = createDatabase(process.env.DATABASE_URL); const token = process.env.APP_LOCAL_PROOF_TOKEN; const stored = await db.prisma.session.findUnique({ where: { tokenHash: createHash('sha256').update(token).digest('base64') }, select: { expiresAt: true, userId: true } }); sessionState = { sessionFound: stored !== null, sessionActive: stored !== null && stored.expiresAt > new Date(), sessionOwnerMatches: stored?.userId === ${JSON.stringify(expectedUserId)} }; const p = await createAuthService(db.prisma, 'open').getProfile(token); const safe = { id: p.id, isPlatformAdministrator: p.isPlatformAdministrator, memberships: p.memberships.map((m) => ({ organizationId: m.organization.id, slug: m.organization.slug, role: m.role })) }; if (p.id !== ${JSON.stringify(expectedUserId)} || !safe.memberships.some((m) => m.organizationId === ${JSON.stringify(expectedOrganizationId)} && m.slug === 'app-07-local-demonstration' && m.role === 'STUDENT')) throw new Error('Profile identity or membership mismatch'); console.log(JSON.stringify(safe)); } catch (error) { const status = [400, 401, 403, 404, 409].includes(error?.status) ? error.status : undefined; const code = typeof error?.code === 'string' && /^(?:ERR_[A-Z0-9_]+|P\\d{4})$/.test(error.code) ? error.code : undefined; console.error(JSON.stringify({ diagnostic: 'native-profile-proof-failed', status, code, ...sessionState })); process.exitCode = 1; } finally { if (db) { try { await db.prisma.$disconnect(); } catch { console.error(JSON.stringify({ diagnostic: 'native-profile-proof-disconnect-failed' })); process.exitCode = 1; } } } })();`;
}

async function verifyAuthProfile(token, metadata, childEnv) {
  const proof = nativeProfileProofSource();
  const env = safeChildEnvironment({
    ...childEnv,
    APP_LOCAL_PROOF_TOKEN: token,
  });
  let output;
  try {
    output = run("pnpm", ["exec", "tsx", "-e", proof], {
      env,
      phase: "native AuthService profile proof",
      timeout: 30_000,
      safeDiagnostic: true,
    });
  } catch (error) {
    if (error.message.includes("auth-status-401")) {
      const provesSessionInvalidation =
        /session-found-false|active-false|owner-false/.test(error.message);
      if (provesSessionInvalidation) {
        const invalidated = new Error(error.message);
        invalidated.provesSessionInvalidation = true;
        throw invalidated;
      }
    }
    throw error;
  }
  const profile = JSON.parse(output.trim());
  if (
    profile.id !== expectedUserId ||
    !profile.memberships.some(
      (membership) =>
        membership.organizationId === expectedOrganizationId &&
        membership.slug === "app-07-local-demonstration" &&
        membership.role === "STUDENT",
    )
  ) {
    fail(
      "Native AuthService profile proof did not match the restored user and membership",
    );
  }
}

function writeMetadata(directory, value) {
  const path = join(directory, "local-db.json");
  const tempPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
}

function readMetadata(directory) {
  const path = join(directory, "local-db.json");
  try {
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0
    ) {
      fail("Local metadata must be an owned mode-0600 regular file");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function runMigrations(databaseUrl, safeEnv, config) {
  run("pnpm", ["exec", "prisma", "generate", "--config", config], {
    env: safeChildEnvironment({
      ...safeEnv,
      DATABASE_URL: databaseUrl,
    }),
    phase: "Prisma client generation",
    timeout: 90_000,
  });
  run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", config], {
    env: safeChildEnvironment({
      ...safeEnv,
      DATABASE_URL: databaseUrl,
    }),
    phase: "canonical migration deployment",
    timeout: 90_000,
  });
}

function metadataMatchesManagedTarget(metadata, existing, expected) {
  return (
    metadata?.target?.containerId === existing.Id &&
    metadata.target?.volume === volumeName &&
    metadata.target?.port === Number(targetPort) &&
    Array.isArray(metadata.migrations) &&
    metadata.migrations.length === expected.length &&
    metadata.migrations.every(
      (migration, index) =>
        migration.name === expected[index].name &&
        migration.checksum === expected[index].checksum,
    ) &&
    Array.isArray(metadata.dataFingerprint)
  );
}

export async function verifyTargetBeforeMigrations(
  client,
  { existing, metadata, expected },
) {
  const targetRelations = await getTargetRelations(client);

  if (targetRelations.length === 0) {
    if (metadata) {
      fail(
        "Saved local DB metadata exists for an otherwise fresh managed target; refusing to adopt",
      );
    }
    return { kind: "fresh" };
  }

  const canonicalRelations = canonicalTargetRelations();
  if (
    targetRelations.length !== canonicalRelations.length ||
    targetRelations.some(
      (relation, index) =>
        relation.name !== canonicalRelations[index].name ||
        relation.kind !== canonicalRelations[index].kind,
    )
  ) {
    fail(
      "Existing managed target relation catalog is not the checked-out canonical schema; refusing migration deployment",
    );
  }

  if (!metadataMatchesManagedTarget(metadata, existing, expected)) {
    fail(
      "Saved local DB metadata does not match the managed target; refusing to adopt",
    );
  }

  const ledger = await client.query(
    `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`,
  );
  verifyMigrationRows(ledger.rows, expected);

  const targetFingerprint = await getTargetFingerprint(client);
  compareFingerprints(metadata.dataFingerprint, targetFingerprint);
  const evidenceTableCounts = await verifyNewTablesEmpty(client);
  const cleanBootstrap = isCleanBootstrapCandidate(
    targetFingerprint,
    evidenceTableCounts,
    targetRelations,
  );
  return { kind: "adoptable", cleanBootstrap };
}

export async function runMigrationsAfterTargetPreflight(
  client,
  { existing, metadata, expected, runMigrations: deploy },
) {
  const preflight = await verifyTargetBeforeMigrations(client, {
    existing,
    metadata,
    expected,
  });
  await deploy();
  return preflight;
}

async function migrate() {
  const stateDirectory = ensurePrivateStateDirectory();
  const tempDirectory = mkdtempSync(join(tmpdir(), "invoiceops-local-db-"));
  const dockerConfig = join(tempDirectory, "docker-config");
  mkdirSync(dockerConfig, { mode: 0o700 });
  const dockerEnv = safeChildEnvironment({
    DOCKER_HOST: "unix:///var/run/docker.sock",
    DOCKER_CONFIG: dockerConfig,
  });
  let client;
  let managedTarget;
  let metadata;
  try {
    dockerCall(["info", "--format", "{{.ServerVersion}}"], {
      env: dockerEnv,
      phase: "local Docker socket preflight",
    });
    let existing = verifyManagedContainer(
      dockerInspect([containerName], dockerEnv, "managed container preflight"),
    );
    managedTarget = existing;
    let createdPassword;
    let imageId;
    if (!existing) {
      const source = verifySourceContainer(
        dockerInspect(
          [sourceContainer],
          dockerEnv,
          "selected source container inspection",
        )?.[0],
      );
      imageId = source.Image;
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        fail("Selected source PostgreSQL image identity is invalid");
      }
      dockerCall(["image", "inspect", imageId], {
        env: dockerEnv,
        phase: "cached PostgreSQL image verification",
      });
      verifyManagedVolume(dockerEnv);
      createdPassword = randomBytes(32).toString("base64url");
      const containerEnv = safeChildEnvironment({
        ...dockerEnv,
        POSTGRES_PASSWORD: createdPassword,
        POSTGRES_USER: databaseRole,
        POSTGRES_DB: databaseName,
      });
      dockerCall(
        [
          "create",
          "--name",
          containerName,
          "--label",
          `${ownerLabel}=${ownerValue}`,
          "--label",
          `${projectLabel}=${projectValue}`,
          "--pull=never",
          "--memory=768m",
          "-p",
          `127.0.0.1:${targetPort}:5432`,
          "-v",
          `${volumeName}:/var/lib/postgresql/data`,
          "--env",
          "POSTGRES_PASSWORD",
          "--env",
          "POSTGRES_USER",
          "--env",
          "POSTGRES_DB",
          imageId,
        ],
        {
          env: containerEnv,
          phase: "owned target container creation",
        },
      );
      existing = verifyManagedContainer(
        dockerInspect(
          [containerName],
          dockerEnv,
          "new container ownership verification",
        ),
      );
      if (!existing) {
        fail("New managed target identity was not returned by Docker");
      }
      managedTarget = existing;
      dockerCall(["start", existing.Id], {
        env: dockerEnv,
        phase: "owned target start",
      });
      existing = verifyManagedContainer(
        dockerInspect([existing.Id], dockerEnv, "started target verification"),
      );
    }
    if (!existing.State?.Running) {
      dockerCall(["start", existing.Id], {
        env: dockerEnv,
        phase: "owned target start",
      });
      existing = verifyManagedContainer(
        dockerInspect(
          [existing.Id],
          dockerEnv,
          "restarted target verification",
        ),
      );
    }
    imageId ??= existing.Image;
    const targetPassword =
      createdPassword ?? readNewOwnedPassword(existing, dockerEnv);
    const databaseUrl = `postgresql://${encodeURIComponent(databaseRole)}:${encodeURIComponent(targetPassword)}@127.0.0.1:${targetPort}/${encodeURIComponent(databaseName)}?schema=public`;
    console.info("stage:managed-target-readiness");
    await waitForManagedPostgres(databaseUrl);
    const config = migrationConfig(tempDirectory);
    metadata = readMetadata(stateDirectory);
    const expected = expectedMigrations();
    const sourceFingerprintSql = tableFingerprintSql();
    const env = safeChildEnvironment({
      DOCKER_HOST: dockerEnv.DOCKER_HOST,
      DOCKER_CONFIG: dockerConfig,
    });
    const probe = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3_000,
      query_timeout: 5_000,
    });
    await probe.connect();
    try {
      await runMigrationsAfterTargetPreflight(probe, {
        existing,
        metadata,
        expected,
        runMigrations: async () => {
          console.info("stage:canonical-prisma-migrations");
          await runMigrations(databaseUrl, env, config);
        },
      });
    } finally {
      await probe.end();
    }
    client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3_000,
      query_timeout: 5_000,
    });
    await client.connect();
    const ledger = await client.query(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`,
    );
    verifyMigrationRows(ledger.rows, expected);
    const targetBefore = await getTargetFingerprint(client);
    const newTableCounts = await verifyNewTablesEmpty(client);
    const targetRelations = await getTargetRelations(client);
    const cleanBootstrap = isCleanBootstrapCandidate(
      targetBefore,
      newTableCounts,
      targetRelations,
    );
    await verifyAuditGuard(
      client,
      targetBefore.some(
        (fingerprint) =>
          fingerprint.table === "DecisionEvent" && Number(fingerprint.rows) > 0,
      ),
    );
    if (metadata) {
      if (
        metadata.target?.containerId !== existing.Id ||
        metadata.target?.volume !== volumeName ||
        metadata.target?.port !== Number(targetPort) ||
        !Array.isArray(metadata.migrations) ||
        metadata.migrations.length > expected.length ||
        metadata.migrations.some(
          (migration, index) =>
            migration.name !== expected[index].name ||
            migration.checksum !== expected[index].checksum,
        )
      ) {
        if (!cleanBootstrap) {
          fail(
            "Saved local DB metadata does not match the managed target; refusing to adopt",
          );
        }
        metadata = null;
      }
      if (metadata) {
        metadata.migrations = expected;
        metadata.target.imageId ??= imageId;
        writeMetadata(stateDirectory, metadata);
      }
    }
    if (!metadata) {
      if (!cleanBootstrap) {
        fail(
          "Managed target contains data but has no import manifest; refusing duplicate or destructive transfer",
        );
      }
      verifySourceContainer(
        dockerInspect(
          [sourceContainer],
          dockerEnv,
          "source identity verification before transfer",
        )?.[0],
      );
      const sourceCatalog = psqlSource(
        sourceCatalogSql,
        dockerEnv,
        "source catalog inventory",
      );
      if (isVerifiedCleanSourceCatalog(sourceCatalog)) {
        metadata = {
          createdAt: new Date().toISOString(),
          bootstrap: "verified-clean-source",
          target: {
            container: containerName,
            containerId: existing.Id,
            volume: volumeName,
            host: "127.0.0.1",
            port: Number(targetPort),
            database: databaseName,
            role: databaseRole,
            imageId,
          },
          source: {
            container: sourceContainer,
            database: sourceCatalog.database,
            role: sourceCatalog.role,
            counts: {
              users: 0,
              organizations: 0,
              memberships: 0,
              invoices: 0,
              decisions: 0,
              policies: 0,
              sessions: 0,
            },
          },
          migrations: expected,
          importFingerprint: targetBefore,
          dataFingerprint: targetBefore,
        };
        writeMetadata(stateDirectory, metadata);
      } else {
        const source = psqlSource(
          sourceInventorySql,
          dockerEnv,
          "bounded source database inventory",
        );
        if (
          source.database !== databaseName ||
          source.role !== databaseRole ||
          Number(source.guardViolationCount) > 0
        ) {
          if (Number(source.guardViolationCount) > 0) {
            fail(
              `Source rows violate the corrected audit guard; count=${source.guardViolationCount}; rows=${JSON.stringify(source.guardViolationSample)}`,
            );
          }
          fail(
            "Selected source database identity did not match the approved local target",
          );
        }
        const sourceFingerprint = psqlSource(
          sourceFingerprintSql,
          dockerEnv,
          "source aggregate fingerprint",
        );
        console.info("stage:source-data-only-transfer");
        const dump = sourceDump(dockerEnv);
        if (!Buffer.isBuffer(dump) || dump.length === 0) {
          fail("Source data-only dump was empty");
        }
        dockerCall(
          [
            "exec",
            "-i",
            "-e",
            "PGPASSFILE=/dev/null",
            "-e",
            "PGCONNECT_TIMEOUT=3",
            "-e",
            "PGOPTIONS=-c statement_timeout=3000 -c lock_timeout=1000",
            containerName,
            "pg_restore",
            "-w",
            "-h",
            "/var/run/postgresql",
            "-p",
            "5432",
            "-U",
            databaseRole,
            "-d",
            databaseName,
            "--data-only",
            "--no-owner",
            "--no-acl",
            "--single-transaction",
            "--exit-on-error",
          ],
          {
            env: dockerEnv,
            input: dump,
            phase: "owned target data restore",
            timeout: 30_000,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        const targetFingerprint = await getTargetFingerprint(client);
        compareFingerprints(sourceFingerprint, targetFingerprint);
        await verifyNewTablesEmpty(client);
        await verifyAuditGuard(
          client,
          targetFingerprint.some(
            (fingerprint) =>
              fingerprint.table === "DecisionEvent" &&
              Number(fingerprint.rows) > 0,
          ),
        );
        metadata = {
          createdAt: new Date().toISOString(),
          target: {
            container: containerName,
            containerId: existing.Id,
            volume: volumeName,
            host: "127.0.0.1",
            port: Number(targetPort),
            database: databaseName,
            role: databaseRole,
            imageId,
          },
          source: {
            container: sourceContainer,
            database: source.database,
            role: source.role,
            counts: {
              users: Number(source.users),
              organizations: Number(source.organizations),
              memberships: Number(source.memberships),
              invoices: Number(source.invoices),
              decisions: Number(source.decisions),
              policies: Number(source.policies),
              sessions: Number(source.sessions),
            },
          },
          migrations: expected,
          importFingerprint: targetFingerprint,
          dataFingerprint: targetFingerprint,
        };
        writeMetadata(stateDirectory, metadata);
      }
    }
    let session;
    const expectedDemoUser = await client.query(
      'SELECT 1 FROM "User" WHERE id = $1',
      [expectedUserId],
    );
    if (
      metadata.bootstrap !== "verified-clean-source" &&
      expectedDemoUser.rowCount === 1
    ) {
      const profileEnv = { DATABASE_URL: databaseUrl };
      session = await ensureSession(
        client,
        stateDirectory,
        metadata,
        profileEnv,
      );
      metadata.session = session.session;
      metadata.dataFingerprint = await getTargetFingerprint(client);
      writeMetadata(stateDirectory, metadata);
    } else if (metadata.bootstrap !== "verified-clean-source") {
      console.info("stage:profile-proof-skipped-no-canonical-demo-user");
    }
    console.info(
      JSON.stringify(
        {
          status: "ready",
          target: metadata.target,
          migrationCount: expected.length,
          dataFingerprint: metadata.dataFingerprint,
          bootstrap: metadata.bootstrap,
          session: session && {
            sessionId: metadata.session.sessionId,
            expiresAt: metadata.session.expiresAt,
            tokenFile: session.tokenPath,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (client) await client.end();
    } finally {
      try {
        if (managedTarget) {
          cleanupManagedClone(managedTarget, dockerEnv);
          cleanupManagedMetadata(stateDirectory, metadata, managedTarget);
          console.info(
            "cleanup: exact managed migration-validation clone and volume removed",
          );
        }
      } finally {
        rmSync(tempDirectory, { recursive: true, force: true });
      }
    }
  }
}

function status() {
  const stateDirectory = ensurePrivateStateDirectory();
  const metadata = readMetadata(stateDirectory);
  if (!metadata) {
    console.info(
      JSON.stringify({
        status: "not-initialized",
        next: "pnpm db:local:migrate",
      }),
    );
    return;
  }
  console.info(
    JSON.stringify(
      {
        status: "managed",
        target: metadata.target,
        migrationCount: metadata.migrations?.length,
        dataFingerprint: metadata.dataFingerprint,
        session: metadata.session && {
          sessionId: metadata.session.sessionId,
          expiresAt: metadata.session.expiresAt,
          tokenFile: metadata.session.tokenFile,
        },
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (
    process.argv.length !== 3 ||
    !["migrate", "status"].includes(process.argv[2])
  ) {
    console.error("Usage: node scripts/local-db.mjs <migrate|status>");
    process.exitCode = 2;
  } else {
    const operation = process.argv[2];
    (operation === "migrate" ? migrate() : Promise.resolve(status())).catch(
      (error) => {
        console.error(
          error instanceof Error ? error.message : "Local DB operation failed",
        );
        process.exitCode = 1;
      },
    );
  }
}
