/** Invoked only by scripts/mlflow07-proof.mjs prove. Never auto-discovered as a unit test.
 * Genuine HTTP sessions, canonical migrations and provider writes; no mocked services.
 * Only the provisioning cooldown clock is advanced. Deadline timers remain real.
 * Fresh connections isolate fixture listener teardown from the global fetch pool.
 * This is not evidence of production keep-alive or connection-pool resilience.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { normalizeRut } from "../../src/identity.js";
import { createPlatformAdministratorService } from "../../src/platform-administrator.js";
import {
  createMlflowAdminClient,
  providerRecord as record,
  providerList as list,
  providerText as text,
  providerId as numericId,
} from "../../src/mlflow-admin-client.js";
import {
  createAcademicSnapshotReader,
  createMlflowProvisionService,
} from "../../src/mlflow-provision.js";
import { loadProvisionSecrets } from "../../src/mlflow-provision-secrets.js";
import { createMlflowReadClient } from "../../src/mlflow-read-client.js";
import { createMlflowResourceService } from "../../src/mlflow-resources.js";
import { managedRole } from "../../src/mlflow-provision-plan.js";

let assertions = 0;
const phases: string[] = [];
const operations: Array<Record<string, unknown>> = [];
let phase = "initialization";
type Diagnostic = {
  operation: string;
  assertion: string;
  failureKind?: string;
  expectedStatus?: number;
  actualStatus?: number;
  fixtureIndex?: number;
  transportCategory?: string;
  providerOperation?: string;
};
// Typed boundary to the existing JavaScript harness driver; importing it does
// not dispatch a stage. The same controls are exercised by its offline guards.
const helpers = (await import(
  new URL("../../scripts/mlflow07-proof.mjs", import.meta.url).href
)) as {
  createRequestDiagnostics(classify: (error: unknown) => string | undefined): {
    current(): Diagnostic | undefined;
    firstFailure(): Readonly<Diagnostic> | undefined;
    run<T>(context: Diagnostic, work: () => Promise<T>): Promise<T>;
  };
  inspectSerial<T, R>(items: T[], visit: (item: T) => Promise<R>): Promise<R[]>;
  providerOperationLabel(method: string, path: string): string;
};
const requestDiagnostics = helpers.createRequestDiagnostics(classifyTransport);
let diagnostic: Diagnostic = {
  operation: "initialization",
  assertion: "checkpoint.id",
};
let primaryFailure: Diagnostic | undefined;
function classifyTransport(error: unknown): string | undefined {
  const categories: Record<string, string> = {
    ECONNRESET: "CONNECTION_RESET",
    ECONNREFUSED: "CONNECTION_REFUSED",
    EADDRINUSE: "ADDRESS_IN_USE",
    EPIPE: "BROKEN_PIPE",
    ENOTFOUND: "NAME_RESOLUTION",
    UND_ERR_SOCKET: "SOCKET_ERROR",
    UND_ERR_DESTROYED: "CLIENT_DESTROYED",
    UND_ERR_CONNECT_TIMEOUT: "CONNECT_TIMEOUT",
    UND_ERR_HEADERS_TIMEOUT: "HEADERS_TIMEOUT",
    UND_ERR_BODY_TIMEOUT: "BODY_TIMEOUT",
  };
  let current = error;
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== "object") return undefined;
    const item = current as { code?: unknown; cause?: unknown };
    if (typeof item.code === "string" && Object.hasOwn(categories, item.code))
      return categories[item.code];
    current = item.cause;
  }
  return undefined;
}
function step(operation: string, assertion: string, fixtureIndex?: number) {
  diagnostic = {
    operation,
    assertion,
    ...(fixtureIndex ? { fixtureIndex } : {}),
  };
}
function failureEvidence() {
  const detail =
    primaryFailure ?? requestDiagnostics.firstFailure() ?? diagnostic;
  return {
    status: "failed",
    phase,
    category: "LIVE_PROOF_FAILED",
    assertions,
    ...detail,
    failureKind: detail.failureKind ?? "DEPENDENCY",
  };
}
// This bound survives interruption of the parent driver. It stops this worker
// only; provider effects at expiration remain unknown and require scoped cleanup.
const workerDeadline = setTimeout(() => {
  primaryFailure ??= requestDiagnostics.firstFailure() ?? {
    ...diagnostic,
    assertion: "worker.deadline",
    failureKind: "DEADLINE",
  };
  console.error(JSON.stringify(failureEvidence()));
  process.exit(124);
}, 4 * 60_000);
workerDeadline.unref();
function check(condition: unknown, assertion = "invariant"): asserts condition {
  const context = requestDiagnostics.current() ?? diagnostic;
  context.assertion = assertion;
  assertions++;
  if (!condition) {
    context.failureKind = "ASSERTION";
    throw new Error("ASSERTION_FAILED");
  }
}
function equal(left: unknown, right: unknown) {
  check(JSON.stringify(left) === JSON.stringify(right));
}
function rut(body: string) {
  let sum = 0;
  for (let index = 0; index < body.length; index++)
    sum += Number(body[body.length - index - 1]) * (2 + (index % 6));
  const digit = 11 - (sum % 11);
  return normalizeRut(
    body + (digit === 11 ? "0" : digit === 10 ? "K" : String(digit)),
  );
}
const secret = () => randomBytes(24).toString("hex");
const state = record(JSON.parse(process.env.PROOF_STATE ?? "null"));
const env = record(state.env);
const directory = process.env.PROOF_DIRECTORY ?? "";
check(
  /^[a-f0-9]{24}$/.test(text(state.id)) &&
    directory.endsWith(`invoiceops-mlflow07-${state.id}`),
  "checkpoint.id",
);
check(
  state.stage === "proving" &&
    state.project === `invoiceops-mlflow07-proof-20261020-ops01-${state.id}` &&
    /^[a-f0-9]{48}$/.test(text(state.nonce)) &&
    state.root === resolve("../.."),
  "checkpoint.identity",
);
check(
  /^[a-f0-9]{48}$/.test(text(state.appPassword)) &&
    state.databaseUrl ===
      `postgresql://invoiceops:${state.appPassword}@127.0.0.1:18672/invoiceops`,
  "checkpoint.database",
);
check(process.env.DATABASE_URL === state.databaseUrl, "checkpoint.environment");
const providerOrigin = "http://127.0.0.1:18671";
const appOrigin = "http://127.0.0.1:18673";
// Use the same policy for every request, including version discovery. No retry:
// a transport error still fails the proof rather than repeating a possible write.
const fixtureTransportHeaders = Object.freeze({
  Connection: "close",
});
const fixtureFetch: typeof fetch = (input, init) => {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("Connection", fixtureTransportHeaders.Connection);
  return fetch(input, { ...init, headers });
};
const admin = {
  username: text(env.MLFLOW_AUTH_ADMIN_USERNAME),
  password: text(env.MLFLOW_AUTH_ADMIN_PASSWORD),
};
type Credentials = typeof admin;
const database = createDatabase(text(state.databaseUrl));
const prisma = database.prisma;
const users = ["platform", "manager", "alice", "bob", "outsider"].map(
  (name, index) => ({
    name,
    rut: rut(String(12000000 + index)),
    password: secret(),
    mlflowPassword: secret(),
    id: "",
    cookie: "",
  }),
);
const [platform, manager, alice, bob, outsider] = users;
const passwords = Object.fromEntries(
  users.map((u) => [u.rut, u.mlflowPassword]),
);
// The pre-existing provider account deliberately differs from its operator-file
// entry, so successful authentication proves provisioning did not reset it.
passwords[alice.rut] = secret();
const passwordFile = join(directory, "academic-passwords.json");
writeFileSync(passwordFile, JSON.stringify(passwords), {
  mode: 0o600,
  flag: "wx",
});
const academicCredentials = (u: typeof alice) => ({
  username: u.rut,
  password: u.mlflowPassword,
});
let cooldownNow = Date.now();
const provision = createMlflowProvisionService({
  client: createMlflowAdminClient(
    {
      mode: "local-development",
      nodeEnv: "development",
      baseUrl: providerOrigin,
      ...admin,
    },
    fixtureFetch,
  ),
  snapshot: createAcademicSnapshotReader(prisma),
  credentials: (names) =>
    loadProvisionSecrets(passwordFile, resolve("../.."), names),
  now: () => cooldownNow,
});
const auth = createAuthService(prisma, "open");
const app = () =>
  createApp(database, auth, {
    platformAdministrators: createPlatformAdministratorService(prisma),
    mlflowProvision: provision,
    mlflowResources: createMlflowResourceService(
      prisma,
      createMlflowReadClient(
        {
          readUrl: providerOrigin,
          uiUrl: providerOrigin,
          ...admin,
        },
        fixtureFetch,
      ),
      providerOrigin,
    ),
  });
let server: Server | undefined;
async function listen() {
  step("listener-start", "app.listen");
  server = app().listen(18673, "127.0.0.1");
  await new Promise<void>((accept, reject) => {
    server!.once("listening", accept);
    server!.once("error", reject);
  });
}
async function close() {
  if (server) {
    if (!primaryFailure) step("listener-close", "app.close");
    server.closeAllConnections();
    await new Promise<void>((accept, reject) =>
      server!.close((error) => (error ? reject(error) : accept())),
    );
    server = undefined;
  }
}
async function boundedBody(response: Response): Promise<string> {
  const context = requestDiagnostics.current() ?? diagnostic;
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      context.assertion = "http.body";
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks).toString("utf8");
      size += part.value.byteLength;
      check(size <= 1024 * 1024, "http.body-limit");
      chunks.push(part.value);
    }
  } catch (error) {
    context.failureKind ??=
      error instanceof Error && error.name === "TimeoutError"
        ? "NETWORK_TIMEOUT"
        : "BODY_FAILED";
    throw error;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
async function http(
  origin: string,
  path: string,
  method: string,
  body: object | undefined,
  headers: Record<string, string>,
  expected: number,
) {
  const operation =
    origin === providerOrigin
      ? "provider-request"
      : path === "/auth/signup"
        ? "signup"
        : path === "/auth/login"
          ? "login"
          : path === "/profile"
            ? "profile"
            : "app-request";
  const fixtureIndex =
    operation === "signup" || operation === "login"
      ? diagnostic.fixtureIndex
      : undefined;
  const context: Diagnostic = {
    operation,
    assertion: "http.fetch",
    expectedStatus: expected,
    ...(fixtureIndex ? { fixtureIndex } : {}),
    ...(origin === providerOrigin
      ? { providerOperation: helpers.providerOperationLabel(method, path) }
      : {}),
  };
  return requestDiagnostics.run(context, async () => {
    let response: Response;
    try {
      response = await fixtureFetch(new URL(path, origin), {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(origin === providerOrigin ? 5000 : 65_000),
      });
    } catch (error) {
      context.failureKind =
        error instanceof Error && error.name === "TimeoutError"
          ? "NETWORK_TIMEOUT"
          : "FETCH_FAILED";
      throw error;
    }
    context.actualStatus = response.status;
    const raw = await boundedBody(response);
    check(response.status === expected, "http.status");
    const json = response.headers
      .get("content-type")
      ?.includes("application/json");
    check(
      !raw || json || expected === 403 || expected === 401,
      "http.content-type",
    );
    context.assertion = "http.json";
    let data: Record<string, unknown>;
    try {
      data = raw && json ? record(JSON.parse(raw)) : {};
    } catch (error) {
      context.failureKind = "RESPONSE_FORMAT";
      throw error;
    }
    return {
      data,
      cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  });
}
const appRequest = (
  path: string,
  method = "GET",
  body?: object,
  user = platform,
  expected = 200,
  origin = appOrigin,
) =>
  http(
    appOrigin,
    path,
    method,
    body,
    { Origin: origin, ...(user.cookie ? { Cookie: user.cookie } : {}) },
    expected,
  );
let providerCalls = 0;
async function provider(
  path: string,
  method = "GET",
  body?: object,
  workspace?: string,
  credentials = admin,
  expected = 200,
) {
  step("provider-request", "provider.call-limit");
  check(++providerCalls <= 1500, "provider.call-limit");
  // Exact local origin and no redirects; no provider request is retried.
  return (
    await http(
      providerOrigin,
      path,
      method,
      body,
      {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        ...(workspace ? { "X-MLFLOW-WORKSPACE": workspace } : {}),
      },
      expected,
    )
  ).data;
}
const rolesPath = "/api/3.0/mlflow/roles";
const experimentsPath = "/api/2.0/mlflow/experiments";
const modelsPath = "/api/2.0/mlflow/registered-models";
async function providerState() {
  const rawUsers = list(
    await provider("/api/2.0/mlflow/users/list"),
    "users",
    100,
  );
  return {
    users: rawUsers.map((value) => {
      const u = record(value);
      return { id: u.id, username: u.username, is_admin: u.is_admin };
    }),
    workspaces: await provider("/api/3.0/mlflow/workspaces"),
    roles: await provider(`${rolesPath}/list`),
  };
}
async function resources(workspace: string) {
  const experiments = list(
    await provider(
      `${experimentsPath}/search`,
      "POST",
      { max_results: 100 },
      workspace,
    ),
    "experiments",
    100,
  );
  const models = list(
    await provider(
      `${modelsPath}/search?max_results=100`,
      "GET",
      undefined,
      workspace,
    ),
    "registered_models",
    100,
  );
  return { experiments: experiments.map(record), models: models.map(record) };
}
async function roleInventory(
  workspace: string,
): Promise<Array<Record<string, unknown> & { assignments: unknown[] }>> {
  const roles = list(
    await provider(
      `${rolesPath}/list?workspace=${workspace}`,
      "GET",
      undefined,
      workspace,
    ),
    "roles",
    100,
  ).map(record);
  // Fixture inspections deliberately match production's serial read shape.
  // This limits synthetic load; it is not a provider performance fix.
  return helpers.inspectSerial(roles, async (role) => ({
    ...role,
    assignments: list(
      await provider(
        `${rolesPath}/users/list?role_id=${numericId(role.id)}`,
        "GET",
        undefined,
        workspace,
      ),
      "assignments",
      100,
    ),
  }));
}
async function provisionRequest(
  workspace: string,
  dryRun: boolean,
  expected = 200,
) {
  return (
    await appRequest(
      "/admin/mlflow/provision",
      "POST",
      { organizationSlug: workspace, dryRun },
      platform,
      expected,
    )
  ).data;
}
function zero(value: unknown) {
  check(Object.values(record(value)).every((count) => count === 0));
}
function operationCounts(value: unknown) {
  const counts = record(value);
  check(
    Object.keys(counts).length === 9 &&
      Object.values(counts).every(
        (v) => Number.isSafeInteger(v) && Number(v) >= 0,
      ),
  );
  return counts;
}
async function reconcile(workspace: string) {
  cooldownNow += 60_001;
  const result = await provisionRequest(workspace, false);
  check(result.status === "ok" && result.unknownEffects === 0);
  equal(operationCounts(result.confirmed), operationCounts(result.planned));
  operations.push({ planned: result.planned, confirmed: result.confirmed });
  // Persist only safe operation counters, not provider payloads or credentials.
  writeFileSync(
    join(directory, `counts-${randomUUID()}.json`),
    JSON.stringify({ planned: result.planned, confirmed: result.confirmed }),
    { mode: 0o600, flag: "wx" },
  );
  return result;
}
type Resource = {
  experiment: string;
  model: string;
  id: string;
  owner: string;
  kind: "user" | "group";
};
function resourcePair(owner: typeof alice | string): Omit<Resource, "id"> {
  return typeof owner === "string"
    ? {
        experiment: `group/${owner}/invoice-risk`,
        model: `group-${owner}-invoice-review`,
        owner,
        kind: "group",
      }
    : {
        experiment: `student/${owner.rut}/invoice-risk`,
        model: `student-${owner.rut}-invoice-review`,
        owner: owner.id,
        kind: "user",
      };
}
async function getPair(
  owner: typeof alice | string,
  workspace: string,
): Promise<Resource> {
  const pair = resourcePair(owner);
  const data = await provider(
    `${experimentsPath}/get-by-name?experiment_name=${encodeURIComponent(pair.experiment)}`,
    "GET",
    undefined,
    workspace,
  );
  return { ...pair, id: text(record(data.experiment).experiment_id) };
}
async function writes(
  workspace: string,
  pair: Resource,
  credentials: Credentials,
  allowed: boolean,
) {
  const expected = allowed ? 200 : 403;
  await provider(
    "/api/2.0/mlflow/runs/create",
    "POST",
    {
      experiment_id: pair.id,
      start_time: Date.now(),
      tags: [
        { key: "organization_slug", value: workspace },
        { key: "owner_type", value: pair.kind },
        { key: "owner_id", value: pair.owner },
        { key: "created_by_rut", value: credentials.username },
      ],
    },
    workspace,
    credentials,
    expected,
  );
  await provider(
    `${modelsPath}/set-tag`,
    "POST",
    { name: pair.model, key: "created_by_rut", value: credentials.username },
    workspace,
    credentials,
    expected,
  );
}
async function createPair(
  workspace: string,
  prefix: string,
): Promise<Resource> {
  const experiment = `proof/${prefix}`;
  const model = `proof-${prefix}`;
  const created = await provider(
    `${experimentsPath}/create`,
    "POST",
    { name: experiment },
    workspace,
  );
  await provider(`${modelsPath}/create`, "POST", { name: model }, workspace);
  return {
    experiment,
    model,
    id: text(created.experiment_id),
    owner: randomUUID(),
    kind: "group",
  };
}
async function grantRole(
  workspace: string,
  name: string,
  pair: Resource | undefined,
  members: string[],
) {
  const role = record(
    (
      await provider(
        `${rolesPath}/create`,
        "POST",
        { workspace, name },
        workspace,
      )
    ).role,
  );
  const role_id = numericId(role.id);
  for (const [resource_type, resource_pattern, permission] of pair
    ? [
        ["experiment", pair.id, "EDIT"],
        ["registered_model", pair.model, "EDIT"],
      ]
    : [["workspace", "*", "USE"]])
    await provider(
      `${rolesPath}/permissions/add`,
      "POST",
      { role_id, resource_type, resource_pattern, permission },
      workspace,
    );
  for (const username of members)
    await provider(
      `${rolesPath}/assign`,
      "POST",
      { role_id, username },
      workspace,
    );
  return role_id;
}
async function main() {
  await listen();
  try {
    phase = "version-and-auth";
    step("version", "version.fetch");
    const versionContext: Diagnostic = {
      operation: "version",
      assertion: "version.fetch",
      expectedStatus: 200,
    };
    await requestDiagnostics.run(versionContext, async () => {
      const version = await fixtureFetch(`${providerOrigin}/version`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString("base64")}`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      versionContext.actualStatus = version.status;
      check(
        version.ok && (await boundedBody(version)).trim() === "3.16.1",
        "version.response",
      );
    });
    step("database", "database.ready");
    check(await database.isReady(), "database.ready");
    for (const [index, user] of users.entries()) {
      step("signup", "http.fetch", index + 1);
      const signup = await appRequest(
        "/auth/signup",
        "POST",
        { name: user.name, rut: user.rut, password: user.password },
        user,
        201,
      );
      diagnostic.assertion = "auth.signup-user";
      user.id = text(record(signup.data.user).id);
    }
    // A fixture-only listener restart preserves the default five-attempt auth limiter,
    // instead of disabling it, changing its clock, or impersonating client addresses.
    await close();
    await listen();
    for (const [index, user] of users.entries()) {
      step("login", "http.fetch", index + 1);
      const login = await appRequest(
        "/auth/login",
        "POST",
        { rut: user.rut, password: user.password },
        user,
      );
      user.cookie = login.cookie;
      check(user.cookie.startsWith("invoiceops_session="), "auth.login-cookie");
    }
    step("bootstrap", "auth.bootstrap");
    const bootstrap = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/bootstrap-platform-administrator.ts",
        "bootstrap",
        platform.id,
        "--confirm-bootstrap",
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
          DATABASE_URL: text(state.databaseUrl),
        },
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 64 * 1024,
      },
    );
    check(!bootstrap.error && bootstrap.status === 0, "auth.bootstrap");
    const profile = await appRequest("/profile");
    diagnostic.assertion = "auth.profile";
    check(
      record(profile.data.profile).isPlatformAdministrator === true,
      "auth.profile",
    );
    step("fixtures", "dependency");
    const orgA = await prisma.organization.create({
      data: { name: "Proof Academy A", slug: "proof-academy-a" },
    });
    const orgB = await prisma.organization.create({
      data: { name: "Proof Academy B", slug: "proof-academy-b" },
    });
    for (const user of [platform, manager, alice, bob])
      await appRequest(
        `/platform/organizations/${orgA.id}/members`,
        "POST",
        {
          userId: user.id,
          role: [platform, manager].includes(user) ? "ADMIN" : "STUDENT",
        },
        platform,
        201,
      );
    await appRequest(
      `/platform/organizations/${orgB.id}/members`,
      "POST",
      { userId: outsider.id, role: "STUDENT" },
      platform,
      201,
    );
    const groupA = await prisma.group.create({
      data: { organizationId: orgA.id, name: "Proof group A" },
    });
    const groupB = await prisma.group.create({
      data: { organizationId: orgA.id, name: "Proof group B" },
    });
    for (const [group, user] of [
      [groupA, alice],
      [groupB, bob],
    ] as const)
      await prisma.groupMembership.create({
        data: { groupId: group.id, userId: user.id, organizationId: orgA.id },
      });
    const input = { organizationSlug: orgA.slug, dryRun: true };
    await appRequest(
      "/admin/mlflow/provision",
      "POST",
      input,
      { ...platform, cookie: "" },
      401,
    );
    await appRequest("/admin/mlflow/provision", "POST", input, manager, 403);
    await appRequest(
      "/admin/mlflow/provision",
      "POST",
      input,
      platform,
      403,
      "https://foreign.example.test",
    );
    phases.push(phase);

    phase = "dry-run-create-and-access";
    await provider("/api/2.0/mlflow/users/create", "POST", {
      username: alice.rut,
      password: alice.mlflowPassword,
    });
    const before = await providerState();
    const dry = await provisionRequest(orgA.slug, true);
    zero(dry.confirmed);
    check(record(dry.planned).workspace === 1);
    check(record(dry.planned).user === 3);
    equal(await providerState(), before);
    const limited = await provisionRequest(orgA.slug, false, 429);
    check(limited.code === "RATE");
    zero(limited.confirmed);
    await reconcile(orgA.slug);
    await reconcile(orgB.slug);
    const expectedPairs = [
      platform,
      manager,
      alice,
      bob,
      groupA.id,
      groupB.id,
    ].map(resourcePair);
    const actual = await resources(orgA.slug);
    equal(
      actual.experiments.map((e) => e.name).sort(),
      expectedPairs.map((p) => p.experiment).sort(),
    );
    equal(
      actual.models.map((m) => m.name).sort(),
      expectedPairs.map((p) => p.model).sort(),
    );
    const allRoles = await roleInventory(orgA.slug);
    const roles = allRoles.filter((r) => managedRole(text(r.name)));
    // MLflow itself grants the resource creator MANAGE through a synthetic role;
    // optional seed roles are also native scaffolding, not InvoiceOps roles.
    for (const role of allRoles.filter((r) => !managedRole(text(r.name)))) {
      check(
        ["admin", "user"].includes(text(role.name)) ||
          /^__user_\d+__$/.test(text(role.name)),
      );
      for (const assignment of role.assignments)
        check(
          record(assignment).user_id ===
            record(
              (
                await provider(
                  `/api/2.0/mlflow/users/get?username=${admin.username}`,
                )
              ).user,
            ).id,
        );
    }
    equal(
      roles.map((r) => r.name).sort(),
      [
        "invoiceops-base",
        "invoiceops-managers",
        ...[platform, manager, alice, bob].map(
          (u) => `invoiceops-owner-${u.id}`,
        ),
        `group-${groupA.id}`,
        `group-${groupB.id}`,
      ].sort(),
    );
    const providerUsers = list(
      await provider("/api/2.0/mlflow/users/list"),
      "users",
      100,
    ).map(record);
    equal(
      providerUsers.map((u) => u.username).sort(),
      [admin.username, ...users.map((u) => u.rut)].sort(),
    );
    const ids = new Map(providerUsers.map((u) => [u.username, u.id]));
    for (const role of roles) {
      const name = text(role.name);
      const expected =
        name === "invoiceops-base"
          ? [platform, manager, alice, bob]
          : name === "invoiceops-managers"
            ? [platform, manager]
            : name === `group-${groupA.id}`
              ? [alice]
              : name === `group-${groupB.id}`
                ? [bob]
                : users.filter((u) => name === `invoiceops-owner-${u.id}`);
      equal(
        role.assignments.map((a) => record(a).user_id).sort(),
        expected.map((u) => ids.get(u.rut)).sort(),
      );
      const permissions = list(role, "permissions", 20).map(record);
      if (name === "invoiceops-base" || name === "invoiceops-managers") {
        equal(
          permissions.map((p) => [
            p.resource_type,
            p.resource_pattern,
            p.permission,
          ]),
          [["workspace", "*", name === "invoiceops-base" ? "USE" : "MANAGE"]],
        );
      } else {
        const owner = name.startsWith("group-")
          ? name.slice(6)
          : users.find((u) => name === `invoiceops-owner-${u.id}`)!;
        const pair = await getPair(owner, orgA.slug);
        equal(
          permissions
            .map((p) => [p.resource_type, p.resource_pattern, p.permission])
            .sort(),
          [
            ["experiment", pair.id, "EDIT"],
            ["registered_model", pair.model, "EDIT"],
          ].sort(),
        );
      }
    }
    const personal = await getPair(alice, orgA.slug);
    const peer = await getPair(bob, orgA.slug);
    const firstGroup = await getPair(groupA.id, orgA.slug);
    const deletedGroup = await getPair(groupB.id, orgA.slug);
    const foreign = await getPair(outsider, orgB.slug);
    await writes(orgA.slug, personal, academicCredentials(alice), true);
    await writes(orgA.slug, firstGroup, academicCredentials(alice), true);
    await writes(orgA.slug, deletedGroup, academicCredentials(bob), true);
    await writes(orgA.slug, peer, academicCredentials(alice), false);
    await writes(orgA.slug, deletedGroup, academicCredentials(alice), false);
    await writes(orgB.slug, foreign, academicCredentials(alice), false);
    await writes(orgA.slug, peer, academicCredentials(manager), true);
    const reader = await appRequest(
      `/mlflow/resources?organizationId=${orgA.id}&ownerType=user&ownerId=${alice.id}`,
      "GET",
      undefined,
      alice,
    );
    check(
      record(reader.data.experiment).id === personal.id &&
        record(reader.data.registeredModel).name === personal.model,
    );
    check(Array.isArray(reader.data.runs) && reader.data.runs.length > 0);
    await appRequest(
      `/mlflow/resources?organizationId=${orgA.id}&ownerType=group&ownerId=${groupB.id}`,
      "GET",
      undefined,
      alice,
      404,
    );
    phases.push(phase);

    phase = "idempotence-and-password-preservation";
    const stable = {
      state: await providerState(),
      resources: await resources(orgA.slug),
      roles: await roleInventory(orgA.slug),
    };
    const repeat = await reconcile(orgA.slug);
    zero(repeat.planned);
    zero(repeat.confirmed);
    equal(
      {
        state: await providerState(),
        resources: await resources(orgA.slug),
        roles: await roleInventory(orgA.slug),
      },
      stable,
    );
    for (const user of users)
      await provider(
        "/api/2.0/mlflow/users/current",
        "GET",
        undefined,
        undefined,
        academicCredentials(user),
      );
    phases.push(phase);

    phase = "revoke-and-preserve";
    const independent = await createPair(orgA.slug, "independent");
    const direct = await createPair(orgA.slug, "direct");
    const adopted = await createPair(orgA.slug, "adopted");
    await grantRole(orgA.slug, "proof-independent", independent, [alice.rut]);
    await grantRole(orgA.slug, "proof-workspace-access", undefined, [bob.rut]);
    for (const [resource_type, resource_id] of [
      ["experiment", direct.id],
      ["registered_model", direct.model],
    ])
      await provider(
        "/api/3.0/mlflow/users/permissions/grant",
        "POST",
        { username: bob.rut, resource_type, resource_id, permission: "EDIT" },
        orgA.slug,
      );
    const global: Credentials = {
      username: "proof-global-administrator",
      password: secret(),
    };
    await provider("/api/2.0/mlflow/users/create", "POST", global);
    await provider("/api/2.0/mlflow/users/update-admin", "PATCH", {
      username: global.username,
      is_admin: true,
    });
    const adoptedRole = await grantRole(
      orgA.slug,
      `invoiceops-owner-${randomUUID()}`,
      adopted,
      [alice.rut, global.username],
    );
    await writes(orgA.slug, adopted, academicCredentials(alice), true);
    await writes(orgA.slug, independent, academicCredentials(alice), true);
    await writes(orgA.slug, direct, academicCredentials(bob), true);
    const otherWorkspace = {
      resources: await resources(orgB.slug),
      roles: await roleInventory(orgB.slug),
    };
    const protectedRoles = (await roleInventory(orgA.slug)).filter(
      (r) =>
        !text(r.name).startsWith("invoiceops-") &&
        !text(r.name).startsWith("group-"),
    );
    await prisma.groupMembership.delete({
      where: { groupId_userId: { groupId: groupA.id, userId: alice.id } },
    });
    await appRequest(
      `/platform/organizations/${orgA.id}/members/${bob.id}`,
      "DELETE",
      undefined,
      platform,
      204,
    );
    await prisma.group.delete({ where: { id: groupB.id } });
    await appRequest(
      `/platform/organizations/${orgA.id}/members/${manager.id}`,
      "PATCH",
      { role: "STUDENT" },
    );
    const revoked = await reconcile(orgA.slug);
    check(
      Number(record(revoked.confirmed).revoke) >= 6 &&
        Number(record(revoked.confirmed).unassign) >= 5,
    );
    await writes(orgA.slug, firstGroup, academicCredentials(alice), false);
    await writes(orgA.slug, deletedGroup, academicCredentials(bob), false);
    await writes(orgA.slug, peer, academicCredentials(bob), false);
    await writes(orgA.slug, personal, academicCredentials(manager), false);
    await writes(
      orgA.slug,
      await getPair(manager, orgA.slug),
      academicCredentials(manager),
      true,
    );
    await writes(orgA.slug, adopted, academicCredentials(alice), false);
    await writes(orgA.slug, adopted, global, true);
    check(
      record(
        (
          await provider(
            `/api/2.0/mlflow/users/get?username=${global.username}`,
          )
        ).user,
      ).is_admin === true,
    );
    await writes(orgA.slug, independent, academicCredentials(alice), true);
    await writes(orgA.slug, direct, academicCredentials(bob), true);
    await writes(orgB.slug, foreign, academicCredentials(outsider), true);
    const afterRoles = await roleInventory(orgA.slug);
    equal(
      afterRoles.filter(
        (r) =>
          !text(r.name).startsWith("invoiceops-") &&
          !text(r.name).startsWith("group-"),
      ),
      protectedRoles,
    );
    const adoptedAfter = afterRoles.find((r) => r.id === adoptedRole)!;
    zero({ permissions: list(adoptedAfter, "permissions", 10).length });
    equal(
      adoptedAfter.assignments.map((a) => record(a).user_id),
      [
        record(
          (
            await provider(
              `/api/2.0/mlflow/users/get?username=${global.username}`,
            )
          ).user,
        ).id,
      ],
    );
    // Foreign workspace contents and IDs remain intact; its test write adds only a run/tag.
    equal(
      (await resources(orgB.slug)).experiments.map((e) => [
        e.experiment_id,
        e.name,
      ]),
      otherWorkspace.resources.experiments.map((e) => [
        e.experiment_id,
        e.name,
      ]),
    );
    equal(
      (await resources(orgB.slug)).models.map((m) => m.name),
      otherWorkspace.resources.models.map((m) => m.name),
    );
    equal(await roleInventory(orgB.slug), otherWorkspace.roles);
    for (const user of users)
      await provider(
        "/api/2.0/mlflow/users/current",
        "GET",
        undefined,
        undefined,
        academicCredentials(user),
      );
    const final = await reconcile(orgA.slug);
    zero(final.confirmed);
    zero(final.planned);
    check(
      !(await resources(orgA.slug)).models.some((m) =>
        String(m.name).includes("production"),
      ),
    );
    phases.push(phase);
    console.info(
      JSON.stringify({ status: "passed", assertions, phases, operations }),
    );
  } catch (error) {
    // Freeze the primary receipt before listener/database shutdown can change it.
    primaryFailure ??= requestDiagnostics.firstFailure() ?? {
      ...diagnostic,
      transportCategory: classifyTransport(error),
    };
    throw error;
  } finally {
    clearTimeout(workerDeadline);
    await close();
    await prisma.$disconnect();
  }
}
main().catch(() => {
  // Only logical IDs, bounded fixture ordinals, numeric statuses and categories.
  // The driver applies a second explicit allowlist before persistence/output.
  console.error(JSON.stringify(failureEvidence()));
  process.exitCode = 1;
});
