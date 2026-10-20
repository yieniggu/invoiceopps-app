/** Isolated local proof, not a production launcher.
 * Stages: prepare; config-check <checkpoint>;
 * prepare-images --allow-downloads <checkpoint>; start <checkpoint>;
 * prove <checkpoint>; cleanup <checkpoint>.
 * Offline request controls: guard-requests (synthetic loopback only).
 * prepare is offline. Only prepare-images permits image downloads/builds.
 * No dotenv, inherited Docker configuration, raw child output, or global cleanup.
 */
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import {
  constants,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

export const backend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(backend, "../..");
const mlflow = resolve(root, "../invoiceops-mlflow");
const stack = resolve(root, "../invoiceops-stack");
const privateParent = realpathSync(
  "/var/folders/y3/m1xh54ds39x7c15dzzngkh1r0000gn/T/opencode",
);
export const ownerKey = "invoiceops.mlflow07.nonce";
const projectPrefix = "invoiceops-mlflow07-proof-20261020-ops01-";
const services = ["postgres", "minio", "minio-init", "mlflow", "app-db"];
const ports = [18671, 18672, 18673];
const random = () => randomBytes(24).toString("hex");
export function demand(condition, category) {
  if (!condition) throw new Error(category);
}
export function checkpointDirectory(id) {
  demand(typeof id === "string" && /^[a-f0-9]{24}$/.test(id), "CHECKPOINT_ID");
  return join(privateParent, `invoiceops-mlflow07-${id}`);
}
function privateObject(path, directory = false) {
  const stat = lstatSync(path);
  demand(
    realpathSync(path) === path &&
      !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1) &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0,
    "PRIVATE_STATE",
  );
}
function save(state) {
  const path = checkpointDirectory(state.id);
  privateObject(path, true);
  const pending = join(path, `checkpoint-${random()}.next`);
  writeFileSync(pending, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  renameSync(pending, join(path, "checkpoint.json"));
}
export function load(id) {
  const directory = checkpointDirectory(id);
  privateObject(directory, true);
  privateObject(join(directory, "checkpoint.json"));
  const state = JSON.parse(
    readFileSync(join(directory, "checkpoint.json"), "utf8"),
  );
  demand(
    state.id === id &&
      state.project === projectPrefix + id &&
      /^[a-f0-9]{48}$/.test(state.nonce) &&
      state.root === root,
    "CHECKPOINT_IDENTITY",
  );
  return state;
}
export function childEnvironment(state, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: checkpointDirectory(state.id),
    TMPDIR: checkpointDirectory(state.id),
    LANG: "C",
    NODE_ENV: "development",
    CI: "1",
    ...extra,
  };
}
// Shared fixture-only request controls. No provider work, retries or timeout changes.
const providerOperationRoutes = new Map([
  ["GET /api/2.0/mlflow/users/list", "GET users.list"],
  ["GET /api/2.0/mlflow/users/get", "GET users.get"],
  ["GET /api/2.0/mlflow/users/current", "GET users.current"],
  ["POST /api/2.0/mlflow/users/create", "POST users.create"],
  ["PATCH /api/2.0/mlflow/users/update-admin", "PATCH users.admin"],
  ["GET /api/3.0/mlflow/workspaces", "GET workspaces.list"],
  ["GET /api/3.0/mlflow/roles/list", "GET roles.list"],
  ["GET /api/3.0/mlflow/roles/users/list", "GET roles.users.list"],
  ["POST /api/3.0/mlflow/roles/create", "POST roles.create"],
  ["POST /api/3.0/mlflow/roles/permissions/add", "POST roles.permissions.add"],
  ["POST /api/3.0/mlflow/roles/assign", "POST roles.assign"],
  [
    "POST /api/3.0/mlflow/users/permissions/grant",
    "POST users.permissions.grant",
  ],
  ["POST /api/2.0/mlflow/experiments/search", "POST experiments.search"],
  ["GET /api/2.0/mlflow/experiments/get-by-name", "GET experiments.by-name"],
  ["POST /api/2.0/mlflow/experiments/create", "POST experiments.create"],
  ["GET /api/2.0/mlflow/registered-models/search", "GET models.search"],
  ["POST /api/2.0/mlflow/registered-models/create", "POST models.create"],
  ["POST /api/2.0/mlflow/registered-models/set-tag", "POST models.set-tag"],
  ["POST /api/2.0/mlflow/runs/create", "POST runs.create"],
]);
export function providerOperationLabel(method, path) {
  // Only exact static route templates. Never fall back to a raw path or query.
  return (
    providerOperationRoutes.get(`${method} ${path.split("?", 1)[0]}`) ??
    "unmapped"
  );
}
export function createRequestDiagnostics(classify = () => undefined) {
  const storage = new AsyncLocalStorage();
  let failure;
  return {
    current: () => storage.getStore(),
    firstFailure: () => failure,
    run(context, work) {
      return storage.run(context, async () => {
        try {
          return await work();
        } catch (error) {
          context.failureKind ??=
            error instanceof Error && error.name === "TimeoutError"
              ? "NETWORK_TIMEOUT"
              : "DEPENDENCY";
          const category = classify(error);
          if (category) context.transportCategory = category;
          failure ??= Object.freeze({ ...context });
          throw error;
        }
      });
    },
  };
}
export async function inspectSerial(items, visit) {
  demand(Array.isArray(items) && items.length <= 100, "INSPECTION_LIMIT");
  const results = [];
  for (const item of items) results.push(await visit(item));
  return results;
}
export function sanitizeLiveFailure(value) {
  const phases = [
    "initialization",
    "version-and-auth",
    "dry-run-create-and-access",
    "idempotence-and-password-preservation",
    "revoke-and-preserve",
  ];
  if (
    !value ||
    value.status !== "failed" ||
    value.category !== "LIVE_PROOF_FAILED" ||
    !phases.includes(value.phase) ||
    !Number.isSafeInteger(value.assertions) ||
    value.assertions < 0 ||
    value.assertions > 1_000_000
  )
    return null;
  const receipt = {
    status: "failed",
    category: "LIVE_PROOF_FAILED",
    phase: value.phase,
    assertions: value.assertions,
  };
  const fields = {
    providerOperation: [...providerOperationRoutes.values(), "unmapped"],
    assertion: [
      "invariant",
      "checkpoint.id",
      "checkpoint.identity",
      "checkpoint.database",
      "checkpoint.environment",
      "http.fetch",
      "http.body",
      "http.body-limit",
      "http.status",
      "http.content-type",
      "http.json",
      "provider.call-limit",
      "version.fetch",
      "version.response",
      "database.ready",
      "auth.signup-user",
      "auth.login-cookie",
      "auth.bootstrap",
      "auth.profile",
      "app.listen",
      "app.close",
      "dependency",
      "worker.deadline",
    ],
    operation: [
      "initialization",
      "version",
      "database",
      "signup",
      "listener-close",
      "listener-start",
      "login",
      "bootstrap",
      "profile",
      "fixtures",
      "app-request",
      "provider-request",
    ],
    failureKind: [
      "ASSERTION",
      "FETCH_FAILED",
      "BODY_FAILED",
      "RESPONSE_FORMAT",
      "DEPENDENCY",
      "DEADLINE",
      "NETWORK_TIMEOUT",
    ],
    transportCategory: [
      "CONNECTION_RESET",
      "CONNECTION_REFUSED",
      "ADDRESS_IN_USE",
      "BROKEN_PIPE",
      "NAME_RESOLUTION",
      "SOCKET_ERROR",
      "CLIENT_DESTROYED",
      "CONNECT_TIMEOUT",
      "HEADERS_TIMEOUT",
      "BODY_TIMEOUT",
    ],
  };
  for (const [field, allowed] of Object.entries(fields))
    if (allowed.includes(value[field])) receipt[field] = value[field];
  for (const field of ["expectedStatus", "actualStatus"])
    if (
      Number.isSafeInteger(value[field]) &&
      value[field] >= 100 &&
      value[field] <= 599
    )
      receipt[field] = value[field];
  if (
    Number.isSafeInteger(value.fixtureIndex) &&
    value.fixtureIndex >= 1 &&
    value.fixtureIndex <= 5
  )
    receipt.fixtureIndex = value.fixtureIndex;
  return receipt;
}
function run(state, binary, args, budget, extra = {}) {
  const remaining = state.deadline ? state.deadline - Date.now() : budget;
  demand(remaining > 0, "TOTAL_DEADLINE");
  const result = spawnSync(binary, args, {
    cwd: backend,
    env: childEnvironment(state, extra),
    encoding: "utf8",
    timeout: Math.min(budget, remaining),
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Never propagate stdout/stderr, arguments, exceptions or paths into an error.
  if (result.error || result.status !== 0) {
    // Small semantic diagnostic allowlist; never echo or regex-redact a raw log.
    const signatures = [
      ["is not a docker command", "DOCKER_PLUGIN_MISSING"],
      ["unknown shorthand flag: 'p'", "DOCKER_PLUGIN_MISSING"],
      ["Cannot connect to the Docker daemon", "ENGINE_UNAVAILABLE"],
      ["failed to parse", "COMPOSE_PARSE_FAILED"],
      ["invalid interpolation", "COMPOSE_INTERPOLATION_FAILED"],
      ["is required", "COMPOSE_REQUIRED_VALUE"],
    ];
    for (const [signature, category] of signatures)
      if (String(result.stderr ?? "").includes(signature))
        console.error(JSON.stringify({ category }));
    if (result.error?.code === "ENOENT")
      console.error(JSON.stringify({ category: "EXECUTABLE_NOT_FOUND" }));
    for (const line of String(result.stderr ?? "").split("\n")) {
      try {
        const receipt = sanitizeLiveFailure(JSON.parse(line));
        if (receipt) {
          // Persist only the sanitized diagnostic through the existing catch/save.
          state.failureReceipt ??= receipt;
          console.error(JSON.stringify(receipt));
        }
      } catch {
        /* Unstructured diagnostics are deliberately not forwarded. */
      }
    }
    const error = new Error(
      result.error?.code === "ETIMEDOUT"
        ? "COMMAND_TIMEOUT_EFFECT_UNKNOWN"
        : "COMMAND_FAILED",
    );
    error.semanticCategory = commandFailureCategory(result);
    throw error;
  }
  return result.stdout.trim();
}
function docker(state, args, budget = 30_000) {
  demand(state.socket && lstatSync(state.socket).isSocket(), "LOCAL_SOCKET");
  const configuration = join(
    checkpointDirectory(state.id),
    "docker/config.json",
  );
  privateObject(configuration);
  // Anonymous config must still find the verified, bundled Compose/Buildx tools.
  // Never consult ~/.docker/config.json or copy its credential helpers/contexts.
  const pluginDirectory = realpathSync(
    "/Applications/Docker.app/Contents/Resources/cli-plugins",
  );
  demand(lstatSync(pluginDirectory).isDirectory(), "DOCKER_PLUGIN_DIRECTORY");
  writeFileSync(
    configuration,
    JSON.stringify({
      auths: { "https://index.docker.io/v1/": {}, "quay.io": {} },
      credsStore: "",
      credHelpers: {},
      cliPluginsExtraDirs: [pluginDirectory],
    }),
    { mode: 0o600 },
  );
  return run(
    state,
    "docker",
    [
      "--config",
      join(checkpointDirectory(state.id), "docker"),
      "--host",
      `unix://${state.socket}`,
      ...args,
    ],
    budget,
    state.env,
  );
}
function list(state, kind, filters = []) {
  const args =
    kind === "container"
      ? ["ps", "-aq", "--no-trunc"]
      : kind === "image"
        ? ["image", "ls", "-q", "--no-trunc"]
        : [kind, "ls", "-q", ...(kind === "network" ? ["--no-trunc"] : [])];
  return [
    ...new Set(
      docker(state, [...args, ...filters.flatMap((f) => ["--filter", f])])
        .split(/\s+/)
        .filter(Boolean),
    ),
  ];
}
function inventory(state) {
  return Object.fromEntries(
    ["container", "network", "volume", "image"].map((kind) => [
      kind,
      list(state, kind),
    ]),
  );
}
function owned(state, kind) {
  return list(state, kind, [`label=${ownerKey}=${state.nonce}`]);
}
export function identityMatches(labels, state, kind) {
  return (
    labels?.[ownerKey] === state.nonce &&
    (kind === "image" ||
      labels?.["com.docker.compose.project"] === state.project)
  );
}
export function rejectExistingVolumes(project, before) {
  // Compose can reuse an existing, unlabeled named volume despite its warning.
  // Project-label checks alone therefore do not establish isolation.
  demand(
    ["postgres_data", "minio_data", "app_data"].every(
      (name) => !before.includes(`${project}_${name}`),
    ),
    "RESERVED_VOLUME_EXISTS",
  );
}
function inspectIdentity(state, kind, id) {
  const labels = JSON.parse(
    docker(state, [
      kind,
      "inspect",
      "--format",
      kind === "container" || kind === "image"
        ? "{{json .Config.Labels}}"
        : "{{json .Labels}}",
      id,
    ]),
  );
  demand(
    identityMatches(labels, state, kind) && !state.before[kind].includes(id),
    "OWNERSHIP_MISMATCH",
  );
}
function captureOwned(state, persist = true) {
  const objects = {};
  for (const kind of ["container", "volume", "network", "image"]) {
    objects[kind] = owned(state, kind);
    for (const id of objects[kind]) inspectIdentity(state, kind, id);
  }
  state.objects = objects;
  if (persist) save(state);
}
function createOwnedStorage(state) {
  // Create and attest storage BEFORE any service can attach or initialize a DB.
  // Docker's volume-create is idempotent by name: if another actor won a race,
  // its missing/mismatched nonce fails attestation without attaching to it.
  for (const name of ["postgres_data", "minio_data", "app_data"]) {
    const volume = `${state.project}_${name}`;
    docker(state, [
      "volume",
      "create",
      "--label",
      `${ownerKey}=${state.nonce}`,
      "--label",
      `com.docker.compose.project=${state.project}`,
      "--label",
      `com.docker.compose.volume=${name}`,
      volume,
    ]);
    inspectIdentity(state, "volume", volume);
  }
  demand(
    list(state, "network", [`name=${state.project}_default`]).length === 0,
    "RESERVED_NETWORK_EXISTS",
  );
  const network = docker(state, [
    "network",
    "create",
    "--label",
    `${ownerKey}=${state.nonce}`,
    "--label",
    `com.docker.compose.project=${state.project}`,
    "--label",
    "com.docker.compose.network=default",
    `${state.project}_default`,
  ]);
  inspectIdentity(state, "network", network);
  captureOwned(state);
}
function attestServices(state) {
  const ids = owned(state, "container");
  demand(
    ids.length === services.length &&
      ids.every((id) => state.objects.container.includes(id)),
    "SERVICE_INVENTORY",
  );
  const names = [];
  for (const id of ids) {
    inspectIdentity(state, "container", id);
    const [name, running, image, raw] = docker(state, [
      "container",
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}|{{json .State.Running}}|{{.Image}}|{{json .HostConfig.PortBindings}}',
      id,
    ]).split("|");
    demand(
      services.includes(name) &&
        image === state.images[name] &&
        (name === "minio-init" || running === "true"),
      "SERVICE_IDENTITY",
    );
    names.push(name);
    const bindings = JSON.parse(raw) ?? {};
    const expected =
      name === "mlflow"
        ? { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "18671" }] }
        : name === "app-db"
          ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "18672" }] }
          : {};
    demand(
      JSON.stringify(bindings) === JSON.stringify(expected),
      "PORT_EXPOSURE",
    );
  }
  demand(new Set(names).size === services.length, "SERVICE_INVENTORY");
}
function preservePresence(state) {
  const after = inventory(state);
  for (const kind of Object.keys(after))
    demand(
      state.before[kind].every((id) => after[kind].includes(id)),
      "UNRELATED_PRESENCE_CHANGED",
    );
  return Object.fromEntries(
    Object.entries(after).map(([kind, ids]) => [kind, ids.length]),
  );
}
function compose(state, args, budget) {
  return docker(
    state,
    [
      "compose",
      "-p",
      state.project,
      "--project-directory",
      mlflow,
      "--env-file",
      "/dev/null",
      "-f",
      join(mlflow, "compose.yml"),
      "-f",
      join(stack, "compose.yml"),
      "-f",
      join(checkpointDirectory(state.id), "proof.json"),
      ...args,
    ],
    budget,
  );
}
const publicImages = Object.freeze({
  postgres: "postgres:16.9-alpine",
  minio: "minio/minio:RELEASE.2025-04-22T22-12-26Z",
  "minio-init": "quay.io/minio/mc:RELEASE.2025-03-12T17-29-24Z",
  "app-db": "postgres:16.9-alpine",
});
const preparationInputs = Object.freeze({
  postgres: publicImages.postgres,
  minio: publicImages.minio,
  "minio-init": publicImages["minio-init"],
  python: "python:3.12.10-slim-bookworm",
});
const preparationSteps = new Set([
  "endpoint",
  "configuration",
  "build-context",
  "baseline",
  "build-mlflow",
  "attest-images",
  "capture-ownership",
  ...Object.keys(preparationInputs).flatMap((name) =>
    ["cache", "pull", "verify"].map((operation) => `${operation}-${name}`),
  ),
]);
const preparationCategories = new Set([
  "COMMAND_FAILED",
  "COMMAND_TIMEOUT_EFFECT_UNKNOWN",
  "TOTAL_DEADLINE",
  "IMAGE_CACHE_METADATA",
  "IMAGE_CACHE_IDENTITY",
  "IMAGE_NOT_AVAILABLE",
  "IMAGE_CONFIG_CONTRACT",
  "BUILD_CONTEXT_CONTRACT",
  "BUILD_RECIPE_CONTRACT",
  "OWNERSHIP_MISMATCH",
  "NONCE_EXISTS",
  "IMAGE_TAG_EXISTS",
  "IMAGE_IDENTITY",
  "PREPARATION_FAILED",
]);
const commandFailureCategories = new Set([
  "ENGINE_UNAVAILABLE",
  "REGISTRY_ACCESS_DENIED",
  "REGISTRY_RATE_LIMIT",
  "NAME_RESOLUTION",
  "TLS_VERIFICATION",
  "DISK_FULL",
  "BUILD_FAILED",
  "EXECUTABLE_NOT_FOUND",
  "TIMEOUT_EFFECT_UNKNOWN",
  "UNCLASSIFIED",
]);
function commandFailureCategory(result) {
  if (result.error?.code === "ETIMEDOUT") return "TIMEOUT_EFFECT_UNKNOWN";
  if (result.error?.code === "ENOENT") return "EXECUTABLE_NOT_FOUND";
  // Bounded semantic hints, not root-cause claims or retained build logs.
  const text = String(result.stderr ?? "")
    .slice(-16_384)
    .toLowerCase();
  for (const [signature, category] of [
    ["cannot connect to the docker daemon", "ENGINE_UNAVAILABLE"],
    ["pull access denied", "REGISTRY_ACCESS_DENIED"],
    ["unauthorized: authentication required", "REGISTRY_ACCESS_DENIED"],
    ["toomanyrequests", "REGISTRY_RATE_LIMIT"],
    ["no such host", "NAME_RESOLUTION"],
    ["x509:", "TLS_VERIFICATION"],
    ["no space left on device", "DISK_FULL"],
    ["failed to solve:", "BUILD_FAILED"],
  ])
    if (text.includes(signature)) return category;
  return "UNCLASSIFIED";
}
function safePreparationFailure(value) {
  if (
    !value ||
    !preparationSteps.has(value.step) ||
    !preparationCategories.has(value.category) ||
    !commandFailureCategories.has(value.semanticCategory)
  )
    return null;
  return {
    step: value.step,
    category: value.category,
    semanticCategory: value.semanticCategory,
  };
}
export function preparationStatus(id) {
  const state = load(id);
  return {
    checkpoint: id,
    stage: [
      "prepared",
      "images-preparing",
      "images-ready",
      "starting",
      "started",
      "proving",
      "proved",
      "cleaned",
    ].includes(state.stage)
      ? state.stage
      : "unmapped",
    failure: preparationCategories.has(state.failure)
      ? state.failure
      : "UNCLASSIFIED",
    baselinePresent: Boolean(state.before),
    runtimeMutationStarted: state.runtimeMutationStarted === true,
    preparationFailure: safePreparationFailure(state.preparationFailure),
  };
}
function preparationStep(state, step, work) {
  demand(preparationSteps.has(step), "PREPARATION_STEP");
  state.preparationStep = step;
  save(state);
  try {
    return work();
  } catch (error) {
    const receipt = {
      step,
      category: preparationCategories.has(error?.message)
        ? error.message
        : "PREPARATION_FAILED",
      semanticCategory: commandFailureCategories.has(error?.semanticCategory)
        ? error.semanticCategory
        : "UNCLASSIFIED",
    };
    state.preparationFailure = receipt;
    console.error(JSON.stringify(receipt));
    throw error;
  }
}
function cachedImage(state, ref) {
  const output = docker(state, [
    "image",
    "ls",
    "--no-trunc",
    "--filter",
    `reference=${ref}`,
    "--format",
    "{{.Repository}}:{{.Tag}}|{{.ID}}",
  ]);
  const rows = output.split("\n").filter(Boolean);
  demand(rows.length <= 1, "IMAGE_CACHE_METADATA");
  if (rows.length === 0) return null;
  const [reference, identity, ...extra] = rows[0].split("|");
  demand(
    reference === ref &&
      extra.length === 0 &&
      /^sha256:[a-f0-9]{64}$/.test(identity),
    "IMAGE_CACHE_METADATA",
  );
  const inspected = docker(state, [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    ref,
  ]);
  demand(inspected === identity, "IMAGE_CACHE_IDENTITY");
  return identity;
}
function imageConfiguration(state) {
  const config = JSON.parse(
    compose(state, ["config", "--format", "json"], 30_000),
  );
  demand(
    Object.keys(config.services).length === services.length &&
      services.every((name) => {
        const service = config.services[name];
        if (!service) return false;
        if (name !== "mlflow")
          return service.image === publicImages[name] && !service.build;
        return (
          service.image === `invoiceops-mlflow07:${state.id}` &&
          service.build?.context === mlflow &&
          service.build.dockerfile === "Dockerfile.mlflow" &&
          Object.keys(service.build).every((key) =>
            ["context", "dockerfile", "labels"].includes(key),
          ) &&
          identityMatches(service.build.labels, state, "image")
        );
      }),
    "IMAGE_CONFIG_CONTRACT",
  );
  return config;
}
function attestImages(state, config, preparing = false) {
  const images = {};
  for (const name of services) {
    const image = JSON.parse(
      docker(state, [
        "image",
        "inspect",
        "--format",
        '{"Id":{{json .Id}},"Config":{"Labels":{{json .Config.Labels}}}}',
        config.services[name].image,
      ]),
    );
    demand(/^sha256:[a-f0-9]{64}$/.test(image.Id), "IMAGE_IDENTITY");
    if (name === "mlflow")
      demand(
        identityMatches(image.Config?.Labels, state, "image") &&
          !state.before.image.includes(image.Id),
        "OWNERSHIP_MISMATCH",
      );
    if (!preparing) demand(state.images?.[name] === image.Id, "IMAGE_CHANGED");
    images[name] = image.Id;
  }
  return images;
}
function prepareImages(state) {
  demand(state.stage === "prepared", "STAGE_ORDER");
  state.deadline = Date.now() + 10 * 60_000;
  preparationStep(state, "endpoint", () => verifyEndpoint(state));
  const config = preparationStep(state, "configuration", () =>
    imageConfiguration(state),
  );
  preparationStep(state, "build-context", () => {
    demand(
      readFileSync(join(mlflow, ".dockerignore"), "utf8").trim() ===
        "**\n!Dockerfile.mlflow\n!.dockerignore\n!docker/\ndocker/**\n!docker/mlflow-entrypoint.sh\n!docker/mlflow-healthcheck.py\n!docker/mlflow-migrate.py",
      "BUILD_CONTEXT_CONTRACT",
    );
    // Pin the network-capable recipe, including its only public base and pip pins.
    demand(
      readFileSync(join(mlflow, "Dockerfile.mlflow"), "utf8") ===
        [
          "FROM python:3.12.10-slim-bookworm",
          "",
          "RUN pip install --no-cache-dir \\",
          '    "mlflow[auth]==3.16.1" \\',
          '    "psycopg2-binary==2.9.10" \\',
          '    "boto3==1.37.34"',
          "",
          "COPY docker/mlflow-entrypoint.sh /usr/local/bin/mlflow-entrypoint",
          "COPY docker/mlflow-migrate.py /usr/local/bin/mlflow-migrate.py",
          "COPY docker/mlflow-healthcheck.py /usr/local/bin/mlflow-healthcheck",
          "",
          "RUN chmod 755 /usr/local/bin/mlflow-entrypoint /usr/local/bin/mlflow-healthcheck",
          "",
          'ENTRYPOINT ["/usr/local/bin/mlflow-entrypoint"]',
          "",
        ].join("\n"),
      "BUILD_RECIPE_CONTRACT",
    );
  });
  preparationStep(state, "baseline", () => {
    state.before = inventory(state);
    for (const kind of ["container", "volume", "network", "image"])
      demand(owned(state, kind).length === 0, "NONCE_EXISTS");
    demand(
      list(state, "image", [`reference=invoiceops-mlflow07:${state.id}`])
        .length === 0,
      "IMAGE_TAG_EXISTS",
    );
  });
  state.stage = "images-preparing";
  save(state); // Durable baseline before any download/build; failures are not startable.
  for (const [name, ref] of Object.entries(preparationInputs)) {
    const identity = preparationStep(state, `cache-${name}`, () =>
      cachedImage(state, ref),
    );
    if (identity === null) {
      preparationStep(state, `pull-${name}`, () =>
        docker(state, ["pull", ref], 90_000),
      );
      preparationStep(state, `verify-${name}`, () =>
        demand(cachedImage(state, ref) !== null, "IMAGE_NOT_AVAILABLE"),
      );
    }
  }
  preparationStep(state, "build-mlflow", () =>
    compose(state, ["build", "mlflow"], 8 * 60_000),
  );
  state.images = preparationStep(state, "attest-images", () =>
    attestImages(state, config, true),
  );
  preparationStep(state, "capture-ownership", () => captureOwned(state));
  state.stage = "images-ready";
  save(state);
}
async function availablePorts() {
  const servers = [];
  try {
    for (const port of ports) {
      const server = createServer();
      await new Promise((accept, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", accept);
      });
      servers.push(server);
    }
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((done) => server.close(done))),
    );
  }
}
export function overlay(state) {
  const labels = { [ownerKey]: state.nonce };
  const all = Object.fromEntries(
    services.map((service) => [service, { labels }]),
  );
  all.mlflow = {
    labels,
    image: `invoiceops-mlflow07:${state.id}`,
    build: { labels },
    ports: ["127.0.0.1:18671:5000"],
  };
  all["app-db"] = {
    labels,
    image: "postgres:16.9-alpine",
    environment: {
      POSTGRES_DB: "invoiceops",
      POSTGRES_USER: "invoiceops",
      POSTGRES_PASSWORD: state.appPassword,
    },
    ports: ["127.0.0.1:18672:5432"],
    volumes: ["app_data:/var/lib/postgresql/data"],
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U invoiceops -d invoiceops"],
      interval: "3s",
      timeout: "3s",
      retries: 30,
    },
  };
  return {
    services: all,
    networks: { default: { labels } },
    volumes: Object.fromEntries(
      ["postgres_data", "minio_data", "app_data"].map((name) => [
        name,
        { labels },
      ]),
    ),
  };
}
export async function prepare() {
  demand(lstatSync(privateParent).isDirectory(), "PRIVATE_PARENT");
  const id = randomBytes(12).toString("hex");
  const directory = checkpointDirectory(id);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "docker"), { mode: 0o700 });
  writeFileSync(join(directory, "docker/config.json"), "{}", {
    mode: 0o600,
    flag: "wx",
  });
  const state = {
    id,
    nonce: random(),
    project: projectPrefix + id,
    root,
    stage: "prepared",
    appPassword: random(),
    env: {
      MLFLOW_AUTH_ADMIN_USERNAME: "proof-operator",
      MLFLOW_AUTH_ADMIN_PASSWORD: random(),
      MLFLOW_FLASK_SERVER_SECRET_KEY: random(),
      STACK_POSTGRES_PASSWORD: random(),
      STACK_MINIO_ROOT_USER: "proof" + id.slice(0, 12),
      STACK_MINIO_ROOT_PASSWORD: random(),
      STACK_MLFLOW_PORT: "18671",
    },
  };
  // JSON is valid Compose YAML. The stack overlay has already replaced the base port.
  // Therefore the identical port below merges without retaining the development port.
  writeFileSync(join(directory, "proof.json"), JSON.stringify(overlay(state)), {
    mode: 0o600,
    flag: "wx",
  });
  writeFileSync(
    join(directory, "prisma.config.mjs"),
    `export default ${JSON.stringify({
      schema: join(backend, "prisma/schema.prisma"),
      migrations: { path: join(backend, "prisma/migrations") },
    }).slice(0, -1)},datasource:{url:process.env.DATABASE_URL}};\n`,
    { mode: 0o600, flag: "wx" },
  );
  save(state);
  return id;
}
export function verifyEndpoint(state) {
  demand(
    !Object.keys(process.env).some((key) => key.startsWith("DOCKER_")),
    "AMBIENT_DOCKER_ENV",
  );
  // This is the preflight-approved local endpoint, never a context or remote URI.
  const socket = realpathSync("/var/run/docker.sock");
  demand(lstatSync(socket).isSocket(), "LOCAL_SOCKET");
  if (state.socket) demand(state.socket === socket, "ENDPOINT_CHANGED");
  state.socket = socket;
  const identity = docker(state, [
    "info",
    "--format",
    "{{.ID}}|{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}",
  ]);
  const fields = identity.split("|");
  demand(
    fields.length === 4 &&
      fields[1].startsWith("27.4.") &&
      fields[2] === "linux" &&
      ["aarch64", "arm64"].includes(fields[3]),
    "ENGINE_IDENTITY",
  );
  if (state.engine) demand(state.engine === fields[0], "ENGINE_CHANGED");
  state.engine = fields[0];
  demand(
    /^v?2\.31\.0(?:-desktop\.\d+)?$/.test(
      docker(state, ["compose", "version", "--short"]),
    ),
    "COMPOSE_VERSION",
  );
}
export function auditCleanup(id) {
  const state = load(id);
  state.deadline = Date.now() + 30_000;
  verifyEndpoint(state);
  const nonceOwnedCounts = Object.fromEntries(
    ["container", "network", "volume", "image"].map((kind) => [
      kind,
      owned(state, kind).length,
    ]),
  );
  const projectScopedCounts = Object.fromEntries(
    ["container", "network", "volume"].map((kind) => [
      kind,
      list(state, kind, [`label=com.docker.compose.project=${state.project}`])
        .length,
    ]),
  );
  return { checkpoint: id, nonceOwnedCounts, projectScopedCounts };
}
export function captureFailureReceipt(id, evidence) {
  const state = load(id);
  const failure = sanitizeLiveFailure(evidence);
  demand(failure !== null, "FAILURE_RECEIPT_INVALID");
  const cleanupAudit = auditCleanup(id);
  const receipt = {
    checkpoint: id,
    evidenceSource: "parent-observed",
    originalFailure: failure,
    checkpointStage: state.stage === "cleaned" ? "cleaned" : "unverified",
    outerCategory:
      state.failure === "COMMAND_FAILED" ? "COMMAND_FAILED" : "not-recorded",
    cleanupAudit,
    cleanupClaim: "scoped-counts-only-not-global-invariance",
  };
  // A separate, immutable receipt: do not rewrite the historical checkpoint.
  writeFileSync(
    join(checkpointDirectory(id), "historical-failure-receipt-v1.json"),
    JSON.stringify(receipt),
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}
async function start(state) {
  demand(state.stage === "images-ready", "STAGE_ORDER");
  // Reserve two minutes for scoped cleanup inside the twenty-minute run budget.
  state.deadline = Date.now() + 18 * 60_000;
  verifyEndpoint(state);
  const config = imageConfiguration(state);
  attestImages(state, config); // Local inspect only; before storage/network/container mutation.
  await availablePorts();
  const beforeStart = inventory(state);
  rejectExistingVolumes(state.project, beforeStart.volume);
  demand(
    list(state, "network", [`name=${state.project}_default`]).length === 0,
    "RESERVED_NETWORK_EXISTS",
  );
  for (const service of services)
    demand(
      list(state, "container", [`name=${state.project}-${service}-1`])
        .length === 0,
      "RESERVED_CONTAINER_EXISTS",
    );
  for (const kind of ["container", "volume", "network"])
    demand(
      list(state, kind, [`label=com.docker.compose.project=${state.project}`])
        .length === 0,
      "PROJECT_EXISTS",
    );
  for (const kind of ["container", "volume", "network"])
    demand(owned(state, kind).length === 0, "NONCE_EXISTS");
  state.stage = "starting";
  save(state); // Durable ownership and baseline BEFORE the first engine mutation.
  compose(state, ["config", "--quiet"], 30_000);
  state.runtimeMutationStarted = true;
  save(state);
  createOwnedStorage(state);
  compose(
    state,
    [
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "--wait-timeout",
      "300",
      ...services,
    ],
    5 * 60_000 + 15_000,
  );
  captureOwned(state);
  // Read only selected identity/port metadata, never Env or full inspect output.
  attestServices(state);
  state.databaseUrl = `postgresql://invoiceops:${state.appPassword}@127.0.0.1:18672/invoiceops`;
  run(
    state,
    join(backend, "node_modules/.bin/prisma"),
    [
      "migrate",
      "deploy",
      "--config",
      join(checkpointDirectory(state.id), "prisma.config.mjs"),
    ],
    90_000,
    { DATABASE_URL: state.databaseUrl },
  );
  state.stage = "started";
  state.presenceCounts = preservePresence(state);
  save(state);
}
function cleanup(state) {
  if (!state.before) return;
  // Recovery is allowed after the execution deadline, but remains separately bounded.
  state.deadline = Date.now() + 120_000;
  verifyEndpoint(state);
  captureOwned(state, false); // Includes objects committed by Docker after a CLI timeout.
  for (const kind of ["container", "network", "volume"]) {
    for (const id of state.objects[kind]) {
      inspectIdentity(state, kind, id);
      docker(state, [
        kind,
        "rm",
        ...(kind === "container" ? ["--force"] : []),
        id,
      ]);
    }
  }
  state.retainedImageCount = 0;
  for (const id of state.objects.image) {
    inspectIdentity(state, "image", id);
    // Keep images with another tag or any consumer. Never force-remove a shared ID.
    const tags = JSON.parse(
      docker(state, ["image", "inspect", "--format", "{{json .RepoTags}}", id]),
    );
    if (
      tags?.length === 1 &&
      tags[0] === `invoiceops-mlflow07:${state.id}` &&
      list(state, "container", [`ancestor=${id}`]).length === 0
    )
      docker(state, ["image", "rm", tags[0]]);
    else state.retainedImageCount++;
  }
  for (const kind of ["container", "network", "volume"])
    demand(owned(state, kind).length === 0, "OWNED_RESOURCES_REMAIN");
  state.presenceCounts = preservePresence(state);
  state.stage = "cleaned";
  save(state); // Retain private evidence and secrets for explicit operator disposal, not repo artifacts.
}
function prove(state) {
  demand(state.stage === "started", "STAGE_ORDER");
  verifyEndpoint(state);
  attestServices(state);
  state.stage = "proving";
  save(state);
  const output = run(
    state,
    process.execPath,
    ["--import", "tsx", "test/runtime/mlflow07-live.ts"],
    4 * 60_000,
    {
      DATABASE_URL: state.databaseUrl,
      PROOF_STATE: JSON.stringify(state),
      PROOF_DIRECTORY: checkpointDirectory(state.id),
    },
  );
  // The worker report is strictly constructed, never forwarded as arbitrary stdout.
  const report = JSON.parse(output.split("\n").at(-1));
  demand(
    report.status === "passed" &&
      Number.isSafeInteger(report.assertions) &&
      Array.isArray(report.phases) &&
      report.phases.every((p) => /^[a-z-]+$/.test(p)),
    "PROOF_REPORT",
  );
  const countKeys = [
    "workspace",
    "user",
    "experiment",
    "model",
    "role",
    "revoke",
    "grant",
    "assign",
    "unassign",
  ];
  demand(
    Array.isArray(report.operations) &&
      report.operations.length === 5 &&
      report.operations.every((operation) =>
        [operation.planned, operation.confirmed].every(
          (counts) =>
            counts &&
            Object.keys(counts).length === countKeys.length &&
            countKeys.every(
              (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
            ),
        ),
      ),
    "PROOF_REPORT",
  );
  state.report = {
    status: "passed",
    assertions: report.assertions,
    phases: report.phases,
    operations: report.operations.map((operation) =>
      Object.fromEntries(
        ["planned", "confirmed"].map((field) => [
          field,
          Object.fromEntries(
            countKeys.map((key) => [key, operation[field][key]]),
          ),
        ]),
      ),
    ),
  };
  state.stage = "proved";
  state.presenceCounts = preservePresence(state);
  save(state);
  console.info(JSON.stringify({ checkpoint: state.id, ...state.report }));
}
async function guardRequests() {
  const { test } = await import("node:test");
  const { default: assert } = await import("node:assert/strict");
  const { createServer } = await import("node:http");
  async function listen(handler) {
    const server = createServer(handler);
    await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", accept);
    });
    return server;
  }
  async function close(server) {
    server.closeAllConnections();
    await new Promise((accept, reject) =>
      server.close((error) => (error ? reject(error) : accept())),
    );
  }
  function get(server, path, signal) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { Connection: "close" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
  }
  await test("provider operation labels contain only allowlisted method/template semantics", () => {
    const marker = "synthetic-private-identity";
    assert.equal(
      providerOperationLabel(
        "GET",
        `/api/3.0/mlflow/roles/users/list?role_id=${marker}`,
      ),
      "GET roles.users.list",
    );
    assert.equal(
      providerOperationLabel("GET", `/api/unknown/${marker}`),
      "unmapped",
    );
    const receipt = sanitizeLiveFailure({
      status: "failed",
      category: "LIVE_PROOF_FAILED",
      phase: "revoke-and-preserve",
      assertions: 660,
      providerOperation: "GET roles.users.list",
      rawPath: marker,
    });
    assert.equal(receipt.providerOperation, "GET roles.users.list");
    assert.ok(!JSON.stringify(receipt).includes(marker));
    assert.ok(
      !Object.hasOwn(
        sanitizeLiveFailure({ ...receipt, providerOperation: marker }),
        "providerOperation",
      ),
    );
  });
  await test(
    "fixture inspection is serial, bounded, ordered and fail-fast without retries",
    { timeout: 3000 },
    async (context) => {
      let active = 0;
      let maximum = 0;
      let calls = 0;
      const server = await listen((_request, response) => {
        active++;
        calls++;
        maximum = Math.max(maximum, active);
        response.once("finish", () => active--);
        setImmediate(() => response.end("{}"));
      });
      try {
        const values = await inspectSerial(
          [0, 1, 2, 3, 4, 5, 6, 7],
          async (value) => {
            const response = await get(server, "/inspection", context.signal);
            assert.equal(response.status, 200);
            await response.text();
            return value;
          },
        );
        assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7]);
        assert.equal(maximum, 1);
        assert.equal(calls, 8);
        const visited = [];
        await assert.rejects(
          inspectSerial([0, 1, 2, 3], async (value) => {
            visited.push(value);
            if (value === 2) throw new Error("SYNTHETIC_FAILURE");
          }),
          /SYNTHETIC_FAILURE/,
        );
        assert.deepEqual(visited, [0, 1, 2]);
        await assert.rejects(
          inspectSerial(Array(101), async () => assert.fail("must not visit")),
          /INSPECTION_LIMIT/,
        );
      } finally {
        await close(server);
      }
    },
  );
  await test(
    "overlapping request diagnostics freeze the failed API, not another request's 200/JSON context",
    { timeout: 3000 },
    async (context) => {
      const scope = createRequestDiagnostics();
      const received = Promise.withResolvers();
      const deadline = () => received.reject(new Error("GUARD_DEADLINE"));
      context.signal.addEventListener("abort", deadline, { once: true });
      const server = await listen((request, response) => {
        if (request.url === "/slow") received.resolve();
        else response.end("{}");
      });
      const abort = new AbortController();
      const failed = {
        operation: "provider-request",
        providerOperation: "GET roles.users.list",
        assertion: "http.fetch",
        expectedStatus: 200,
      };
      try {
        const slow = scope
          .run(failed, async () => {
            await get(
              server,
              "/slow",
              AbortSignal.any([context.signal, abort.signal]),
            );
          })
          .then(
            () => "unexpected-response",
            () => "rejected",
          );
        await received.promise;
        const successful = {
          operation: "provider-request",
          providerOperation: "GET users.current",
          assertion: "http.fetch",
          expectedStatus: 200,
        };
        await scope.run(successful, async () => {
          const response = await get(server, "/fast", context.signal);
          successful.actualStatus = response.status;
          await response.text();
          successful.assertion = "http.json";
          assert.equal(scope.current(), successful);
        });
        assert.equal(scope.firstFailure(), undefined);
        assert.equal(successful.actualStatus, 200);
        assert.equal(successful.assertion, "http.json");
        abort.abort(new DOMException("synthetic deadline", "TimeoutError"));
        assert.equal(await slow, "rejected");
        const primary = scope.firstFailure();
        assert.equal(primary.providerOperation, "GET roles.users.list");
        assert.equal(primary.assertion, "http.fetch");
        assert.equal(primary.failureKind, "NETWORK_TIMEOUT");
        assert.ok(!Object.hasOwn(primary, "actualStatus"));
        assert.ok(Object.isFrozen(primary));
        failed.actualStatus = 200;
        successful.assertion = "invariant";
        assert.ok(!Object.hasOwn(scope.firstFailure(), "actualStatus"));
        assert.equal(scope.firstFailure().assertion, "http.fetch");
        await assert.rejects(
          scope.run(
            {
              ...successful,
              assertion: "http.body",
              failureKind: "BODY_FAILED",
            },
            async () => {
              throw new Error("SYNTHETIC_LATE_FAILURE");
            },
          ),
          /SYNTHETIC_LATE_FAILURE/,
        );
        assert.equal(scope.firstFailure(), primary);
        assert.equal(scope.current(), undefined);
      } finally {
        abort.abort();
        context.signal.removeEventListener("abort", deadline);
        await close(server);
      }
    },
  );
}
export async function main(args) {
  if (args.length === 1 && args[0] === "guard-requests") {
    await guardRequests();
    return;
  }
  if (args[0] === "prepare-images")
    demand(args[1] === "--allow-downloads", "DOWNLOAD_PERMISSION_REQUIRED");
  const [stage, id, ...extra] =
    args[0] === "prepare-images" ? [args[0], ...args.slice(2)] : args;
  demand(
    extra.length === 0 &&
      [
        "prepare",
        "config-check",
        "prepare-images",
        "start",
        "prove",
        "cleanup",
      ].includes(stage),
    "USAGE",
  );
  if (stage === "prepare") {
    demand(!id, "USAGE");
    console.info(
      JSON.stringify({
        stage,
        checkpoint: await prepare(),
        runtime: "not-started",
      }),
    );
    return;
  }
  const state = load(id);
  if (stage === "config-check") {
    demand(state.stage === "prepared", "STAGE_ORDER");
    demand(
      !Object.keys(process.env).some((key) => key.startsWith("DOCKER_")),
      "AMBIENT_DOCKER_ENV",
    );
    // Compose config is a local parser: no info/build/up/pull and no engine call.
    state.socket = realpathSync("/var/run/docker.sock");
    run(
      state,
      process.execPath,
      ["--check", join(checkpointDirectory(id), "prisma.config.mjs")],
      10_000,
    );
    compose(state, ["config", "--quiet"], 30_000);
    console.info(
      JSON.stringify({ stage, checkpoint: id, runtime: "not-started" }),
    );
    return;
  }
  const lock = join(checkpointDirectory(id), "stage.lock");
  // Cleanup may reclaim only an owner-only lock whose recorded process no longer
  // exists. A live or reused PID fails closed; no process is signaled or killed.
  let fd;
  try {
    fd = openSync(
      lock,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    demand(stage === "cleanup" && error?.code === "EEXIST", "STAGE_LOCKED");
    privateObject(lock);
    const pidText = readFileSync(lock, "utf8");
    demand(/^[1-9][0-9]{0,9}$/.test(pidText), "STAGE_LOCKED");
    let dead = false;
    try {
      process.kill(Number(pidText), 0);
    } catch (failure) {
      dead = failure?.code === "ESRCH";
    }
    demand(dead, "STAGE_LOCKED");
    unlinkSync(lock);
    fd = openSync(
      lock,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  }
  writeFileSync(fd, String(process.pid));
  try {
    if (stage === "prepare-images") prepareImages(state);
    if (stage === "start") await start(state);
    if (stage === "prove") prove(state);
    if (stage === "cleanup") cleanup(state);
    console.info(
      JSON.stringify({
        stage: state.stage,
        checkpoint: id,
        runtime: state.report?.status ?? "unverified",
      }),
    );
  } catch (error) {
    const category =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "HARNESS_FAILED";
    state.failure = category;
    try {
      save(state);
    } catch {
      console.error(JSON.stringify({ category: "CHECKPOINT_WRITE_FAILED" }));
    }
    try {
      if (state.runtimeMutationStarted) cleanup(state);
    } catch {
      console.error(
        JSON.stringify({ checkpoint: id, category: "CLEANUP_REQUIRED" }),
      );
    }
    throw new Error(category);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        category:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "HARNESS_FAILED",
        runtime: "unverified",
      }),
    );
    process.exitCode = 1;
  });
