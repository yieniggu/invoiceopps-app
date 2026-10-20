import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuthRateLimiter } from "../src/auth-rate-limit.ts";
import {
  checkpointDirectory,
  childEnvironment,
  identityMatches,
  main,
  overlay,
  ownerKey,
  rejectExistingVolumes,
  sanitizeLiveFailure,
  verifyEndpoint,
} from "./mlflow07-proof.mjs";

const id = "a".repeat(24);
const state = {
  id,
  nonce: "b".repeat(48),
  project: `invoiceops-mlflow07-proof-20261020-ops01-${id}`,
  appPassword: "synthetic-unit-only-not-used-by-runtime",
};

test("checkpoint IDs cannot select another directory or protected file", () => {
  for (const value of [
    "../other",
    "/tmp/other",
    "",
    "a".repeat(25),
    undefined,
    ".env",
    "A".repeat(24),
  ])
    assert.throws(() => checkpointDirectory(value), /CHECKPOINT_ID/);
  assert.ok(checkpointDirectory(id).endsWith(`invoiceops-mlflow07-${id}`));
});

test("cleanup identity requires BOTH exact nonce and exclusive Compose project", () => {
  assert.ok(
    identityMatches(
      { [ownerKey]: state.nonce, "com.docker.compose.project": state.project },
      state,
      "container",
    ),
  );
  for (const kind of ["container", "volume", "network"])
    for (const labels of [
      null,
      {},
      { [ownerKey]: state.nonce },
      {
        [ownerKey]: state.nonce,
        "com.docker.compose.project": "another-project",
      },
      { [ownerKey]: "other", "com.docker.compose.project": state.project },
    ])
      assert.equal(identityMatches(labels, state, kind), false);
  assert.ok(identityMatches({ [ownerKey]: state.nonce }, state, "image"));
});

test("child environment excludes ambient Docker, cloud and application credentials", () => {
  const environment = childEnvironment(state);
  assert.deepEqual(Object.keys(environment).sort(), [
    "CI",
    "HOME",
    "LANG",
    "NODE_ENV",
    "PATH",
    "TMPDIR",
  ]);
  assert.equal(environment.HOME, checkpointDirectory(id));
});

test("resource plan has only five services, new labeled storage and loopback ports", () => {
  const plan = overlay(state);
  assert.deepEqual(Object.keys(plan.services).sort(), [
    "app-db",
    "minio",
    "minio-init",
    "mlflow",
    "postgres",
  ]);
  for (const service of Object.values(plan.services))
    assert.equal(service.labels[ownerKey], state.nonce);
  assert.deepEqual(plan.services.mlflow.ports, ["127.0.0.1:18671:5000"]);
  assert.deepEqual(plan.services["app-db"].ports, ["127.0.0.1:18672:5432"]);
  assert.equal(
    plan.services["app-db"].environment.POSTGRES_PASSWORD,
    state.appPassword,
  );
  for (const volume of Object.values(plan.volumes))
    assert.equal(volume.labels[ownerKey], state.nonce);
  assert.equal(plan.networks.default.labels[ownerKey], state.nonce);
  assert.equal(plan.services.mlflow.build.labels[ownerKey], state.nonce);
});

test("invalid invocation fails offline before endpoint discovery or engine commands", async () => {
  await assert.rejects(main(["down", id]), /USAGE/);
  await assert.rejects(main(["start", "../other"]), /CHECKPOINT_ID/);
  await assert.rejects(main(["prepare", id]), /USAGE/);
});

test("ambient Docker selection is rejected before local socket or engine use", () => {
  const previous = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_CONTEXT = "synthetic-unapproved-context";
  try {
    assert.throws(() => verifyEndpoint(state), /AMBIENT_DOCKER_ENV/);
  } finally {
    if (previous === undefined) delete process.env.DOCKER_CONTEXT;
    else process.env.DOCKER_CONTEXT = previous;
  }
});

test("unlabeled reserved volumes cannot be adopted by Compose", () => {
  rejectExistingVolumes(state.project, ["another-project_postgres_data"]);
  for (const name of ["postgres_data", "minio_data", "app_data"])
    assert.throws(
      () => rejectExistingVolumes(state.project, [`${state.project}_${name}`]),
      /RESERVED_VOLUME_EXISTS/,
    );
});

const historicalFailure = {
  status: "failed",
  category: "LIVE_PROOF_FAILED",
  phase: "version-and-auth",
  assertions: 22,
};

test("historical failure count is preserved without inventing an assertion ID", () => {
  assert.deepEqual(sanitizeLiveFailure(historicalFailure), historicalFailure);
});

test("safe failure diagnostics retain logical IDs and numeric HTTP statuses", () => {
  const evidence = {
    ...historicalFailure,
    operation: "login",
    assertion: "http.status",
    failureKind: "ASSERTION",
    fixtureIndex: 1,
    expectedStatus: 200,
    actualStatus: 429,
  };
  assert.deepEqual(sanitizeLiveFailure(evidence), evidence);
});

test("transport failure without a response never invents an actual HTTP status", () => {
  const evidence = {
    ...historicalFailure,
    operation: "login",
    assertion: "http.fetch",
    failureKind: "FETCH_FAILED",
    fixtureIndex: 1,
    expectedStatus: 200,
    transportCategory: "SOCKET_ERROR",
  };
  const sanitized = sanitizeLiveFailure(evidence);
  assert.deepEqual(sanitized, evidence);
  assert.ok(!Object.hasOwn(sanitized, "actualStatus"));
});

test("failure sanitizer never forwards raw errors, identity, credentials or arbitrary fields", () => {
  const marker = "synthetic-sensitive-marker";
  const sanitized = sanitizeLiveFailure({
    ...historicalFailure,
    operation: marker,
    assertion: marker,
    failureKind: marker,
    transportCategory: marker,
    expectedStatus: marker,
    actualStatus: marker,
    fixtureIndex: marker,
    username: marker,
    password: marker,
    rut: marker,
    cookie: marker,
    url: marker,
    error: marker,
    stack: marker,
    stderr: marker,
  });
  assert.deepEqual(sanitized, historicalFailure);
  assert.ok(!JSON.stringify(sanitized).includes(marker));
});

test("malformed receipt envelopes cannot be promoted to live failure evidence", () => {
  for (const patch of [
    { status: "passed" },
    { category: "arbitrary" },
    { phase: "arbitrary" },
    { assertions: -1 },
    { assertions: 1.5 },
    { assertions: 1_000_001 },
  ])
    assert.equal(sanitizeLiveFailure({ ...historicalFailure, ...patch }), null);
  assert.equal(sanitizeLiveFailure(null), null);
});

test("status and fixture ordinals have explicit bounds, not string redaction", () => {
  for (const number of [-1, 0, 99, 600, 1.5])
    assert.deepEqual(
      sanitizeLiveFailure({
        ...historicalFailure,
        actualStatus: number,
        expectedStatus: number,
        fixtureIndex: number,
      }),
      historicalFailure,
    );
});

function workerTransportPolicy() {
  // Read source, not the live module: importing it would initialize real services.
  const source = readFileSync(
    new URL("../test/runtime/mlflow07-live.ts", import.meta.url),
    "utf8",
  );
  const policy = source.match(
    /const fixtureTransportHeaders = Object\.freeze\(\{\s*Connection: "(close)",?\s*\}\);/,
  );
  assert.ok(
    policy,
    "Worker must declare its explicit non-pooled transport policy",
  );
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1);
  assert.equal((source.match(/await fixtureFetch\(/g) ?? []).length, 2);
  assert.ok(
    /headers\.set\("Connection", fixtureTransportHeaders\.Connection\)/.test(
      source,
    ),
    "Transport policy must set the connection header",
  );
  assert.ok(
    /return fetch\(input, \{ \.\.\.init, headers \}\)/.test(source),
    "Transport facade must preserve request options",
  );
  for (const client of ["createMlflowAdminClient", "createMlflowReadClient"])
    assert.ok(
      new RegExp(
        `${client}\\(\\s*\\{[\\s\\S]*?\\},\\s*fixtureFetch,\\s*\\)`,
      ).test(source),
      `${client} must use the fixture transport`,
    );
  return Object.freeze({ Connection: policy[1] });
}

test("worker isolates both HTTP sites and injected provider clients, including the version request", () => {
  assert.deepEqual(workerTransportPolicy(), { Connection: "close" });
});

async function syntheticListener(stats, port = 0) {
  const limiter = createAuthRateLimiter();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      stats.requests++;
      if (request.headers.connection === "close") stats.closeHeaders++;
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/version") response.statusCode = 200;
      else if (!limiter.allow(request.socket.remoteAddress))
        response.statusCode = 429;
      else response.statusCode = request.url === "/signup" ? 201 : 200;
      response.end('{"synthetic":true}');
    });
  });
  server.on("connection", () => stats.connections++);
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  return server;
}

async function closeSyntheticListener(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
}

async function syntheticRequest(port, path, headers, signal) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: path === "/version" ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(path === "/version" ? {} : { body: "{}" }),
    redirect: "manual",
    signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
  });
  // Match the worker's complete read/cancel/release sequence, without payload logs.
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      assert.ok(bytes <= 1024);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return response.status;
}

test(
  "fresh-connection fixture survives five listener restarts without retry and retains the five-attempt limiter",
  { timeout: 10_000 },
  async (context) => {
    const headers = workerTransportPolicy();
    let responses = 0;
    for (let cycle = 0; cycle < 5; cycle++) {
      const stats = { requests: 0, closeHeaders: 0, connections: 0 };
      let server = await syntheticListener(stats);
      const port = server.address().port;
      try {
        assert.equal(
          await syntheticRequest(port, "/version", headers, context.signal),
          200,
        );
        responses++;
        for (let index = 0; index < 5; index++) {
          assert.equal(
            await syntheticRequest(port, "/signup", headers, context.signal),
            201,
          );
          responses++;
        }
        await closeSyntheticListener(server);
        server = await syntheticListener(stats, port);
        for (let index = 0; index < 5; index++) {
          assert.equal(
            await syntheticRequest(port, "/login", headers, context.signal),
            200,
          );
          responses++;
        }
        assert.equal(
          await syntheticRequest(port, "/login", headers, context.signal),
          429,
        );
        responses++;
        assert.equal(stats.requests, 12);
        assert.equal(stats.closeHeaders, 12);
        assert.equal(stats.connections, 12);
      } finally {
        await closeSyntheticListener(server);
      }
    }
    assert.equal(responses, 60);
  },
);

test(
  "legacy pooled-fetch negative control reproduces the reset before a login HTTP response",
  { timeout: 10_000 },
  async (context) => {
    const failures = { reset: 0, socket: 0 };
    for (let cycle = 0; cycle < 5; cycle++) {
      const stats = { requests: 0, closeHeaders: 0, connections: 0 };
      let server = await syntheticListener(stats);
      const port = server.address().port;
      try {
        for (let index = 0; index < 5; index++)
          assert.equal(
            await syntheticRequest(port, "/signup", {}, context.signal),
            201,
          );
        await closeSyntheticListener(server);
        server = await syntheticListener(stats, port);
        const beforeLogin = stats.requests;
        try {
          const status = await syntheticRequest(
            port,
            "/login",
            {},
            context.signal,
          );
          assert.equal(status, 200);
        } catch (error) {
          const code = error?.cause?.code;
          if (code === "ECONNRESET") failures.reset++;
          else if (code === "UND_ERR_SOCKET") failures.socket++;
          else throw new Error("UNEXPECTED_SYNTHETIC_TRANSPORT_FAILURE");
          assert.equal(stats.requests, beforeLogin);
        }
      } finally {
        await closeSyntheticListener(server);
      }
    }
    assert.ok(
      failures.reset + failures.socket > 0,
      "Negative control must reproduce the old defect",
    );
    context.diagnostic(JSON.stringify({ legacyCycles: 5, ...failures }));
  },
);
