// Execute the real driver with only filesystem/process/socket boundaries replaced.
// Requires --experimental-vm-modules; never invokes Docker or opens a socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as crypto from "node:crypto";
import * as asyncHooks from "node:async_hooks";
import { SourceTextModule, SyntheticModule, createContext } from "node:vm";

const driverUrl = new URL("./mlflow07-proof.mjs", import.meta.url);
const driverSource = readFileSync(driverUrl, "utf8");
const base = path.resolve(
  path.dirname(url.fileURLToPath(driverUrl)),
  "../../../../invoiceops-mlflow",
);
const refs = [
  "postgres:16.9-alpine",
  "minio/minio:RELEASE.2025-04-22T22-12-26Z",
  "quay.io/minio/mc:RELEASE.2025-03-12T17-29-24Z",
];
const pythonBase = "python:3.12.10-slim-bookworm";

async function fixture() {
  const files = new Map();
  const calls = [];
  const images = new Map(
    [...refs, pythonBase].map((ref, index) => [
      ref,
      `sha256:${String(index + 1).repeat(64)}`,
    ]),
  );
  const state = {
    missing: null,
    buildFails: false,
    configChange: null,
    imageChange: null,
    processFailure: null,
    listingChange: null,
  };
  const diagnostics = [];
  const resources = {
    container: new Set(),
    volume: new Set(),
    network: new Set(),
  };
  const privateStat = {
    uid: process.getuid(),
    mode: 0o700,
    nlink: 1,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => true,
    isSocket: () => true,
  };
  const context = createContext({
    process,
    console: {
      info() {},
      error(value) {
        diagnostics.push(JSON.parse(value));
      },
    },
    URL,
    Date,
    Buffer,
    setTimeout,
  });
  const fs = {
    constants: { O_CREAT: 1, O_EXCL: 2, O_WRONLY: 4 },
    lstatSync: () => privateStat,
    realpathSync: (value) => value,
    mkdirSync() {},
    openSync: () => 42,
    closeSync() {},
    unlinkSync: (value) => files.delete(value),
    writeFileSync: (name, value) => files.set(name, String(value)),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFileSync(name) {
      if (files.has(name)) return files.get(name);
      assert.ok(
        name.startsWith(base + "/"),
        "Only allowlisted build source can be read",
      );
      return readFileSync(name, "utf8");
    },
  };
  const child = {
    spawnSync(binary, argv, options) {
      calls.push({ binary, argv, options });
      if (binary.endsWith("node_modules/.bin/prisma")) {
        assert.equal(argv[0], "migrate");
        return { status: 0, stdout: "", stderr: "" };
      }
      assert.equal(
        binary,
        "docker",
        "Only declared synthetic process boundaries may run",
      );
      assert.ok(options.timeout > 0 && options.timeout <= 8 * 60_000);
      assert.ok(!Object.hasOwn(options.env, "DOCKER_CONTEXT"));
      assert.ok(!Object.hasOwn(options.env, "AWS_SECRET_ACCESS_KEY"));
      const args = argv.slice(4);
      const failure = state.processFailure?.(args);
      if (failure) return failure;
      const plan = JSON.parse(
        [...files.entries()].find(([name]) => name.endsWith("/proof.json"))[1],
      );
      const checkpoint = JSON.parse(
        [...files.entries()].find(([name]) =>
          name.endsWith("/checkpoint.json"),
        )[1],
      );
      const labels = {
        ...plan.services.mlflow.build.labels,
        "com.docker.compose.project": checkpoint.project,
      };
      let output = "";
      if (args[0] === "info") output = "synthetic-engine|27.4.0|linux|aarch64";
      else if (args[0] === "compose" && args[1] === "version")
        output = "2.31.0";
      else if (args[0] === "compose") {
        const command = args.slice(args.lastIndexOf("-f") + 2);
        if (command[0] === "config" && command.includes("json")) {
          const plan = JSON.parse(
            [...files.entries()].find(([name]) =>
              name.endsWith("/proof.json"),
            )[1],
          );
          plan.services.postgres.image = refs[0];
          plan.services.minio.image = refs[1];
          plan.services["minio-init"].image = refs[2];
          plan.services.mlflow.build.context = base;
          plan.services.mlflow.build.dockerfile = "Dockerfile.mlflow";
          state.configChange?.(plan);
          output = JSON.stringify(plan);
        } else if (command[0] === "build") {
          if (state.buildFails)
            return { status: 1, stdout: "", stderr: "private-build-layer" };
          const plan = JSON.parse(
            [...files.entries()].find(([name]) =>
              name.endsWith("/proof.json"),
            )[1],
          );
          images.set(plan.services.mlflow.image, `sha256:${"9".repeat(64)}`);
        } else if (command[0] === "up") {
          assert.ok(command.includes("--no-build"));
          assert.equal(command[command.indexOf("--pull") + 1], "never");
          for (const name of Object.keys(plan.services))
            resources.container.add(name);
        }
      } else if (args[0] === "pull") {
        assert.ok([...refs, pythonBase].includes(args[1]));
        if (!images.has(args[1]))
          images.set(args[1], `sha256:${"7".repeat(64)}`);
      } else if (args[0] === "image" && args[1] === "inspect") {
        const target = args.at(-1);
        const ref = images.has(target)
          ? target
          : [...images.entries()].find(
              ([, identity]) => identity === target,
            )?.[0];
        if (!images.has(ref) || state.missing === ref)
          return { status: 1, stdout: "", stderr: "local-only-missing" };
        const value = {
          Id: images.get(ref),
          Config: { Labels: plan.services.mlflow.build.labels },
        };
        state.imageChange?.(value, ref);
        output = args.includes("{{.Id}}")
          ? value.Id
          : args.includes("{{json .Config.Labels}}")
            ? JSON.stringify(value.Config.Labels)
            : JSON.stringify(value);
      } else if (args[0] === "volume" && args[1] === "create") {
        resources.volume.add(args.at(-1));
        output = args.at(-1);
      } else if (args[0] === "network" && args[1] === "create") {
        resources.network.add(args.at(-1));
        output = args.at(-1);
      } else if (
        ["container", "volume", "network"].includes(args[0]) &&
        args[1] === "inspect"
      ) {
        if (
          args[0] === "container" &&
          args.includes("--format") &&
          args[3].includes("PortBindings")
        ) {
          const name = args.at(-1);
          const bindings =
            name === "mlflow"
              ? { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "18671" }] }
              : name === "app-db"
                ? { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "18672" }] }
                : {};
          output = `${name}|true|${checkpoint.images[name]}|${JSON.stringify(bindings)}`;
        } else output = JSON.stringify(labels);
      } else if (args[0] === "ps" || args[1] === "ls") {
        const kind = args[0] === "ps" ? "container" : args[0];
        let ids =
          kind === "image" ? [...images.values()] : [...resources[kind]];
        if (args.includes("--filter")) {
          const filter = args[args.indexOf("--filter") + 1];
          if (kind === "image") {
            ids = filter.startsWith("reference=")
              ? [images.get(filter.slice(10))].filter(Boolean)
              : [...images.entries()]
                  .filter(([ref]) => ref.startsWith("invoiceops-mlflow07:"))
                  .map(([, identity]) => identity);
          }
        }
        output = ids.join("\n");
        if (
          kind === "image" &&
          args.includes("{{.Repository}}:{{.Tag}}|{{.ID}}")
        ) {
          const ref = args[args.indexOf("--filter") + 1].slice(10);
          output = images.has(ref) ? `${ref}|${images.get(ref)}` : "";
          if (state.listingChange) output = state.listingChange(output);
        }
      } else {
        assert.fail(
          `Unexpected synthetic Docker command ${args[0]} ${args[1]}`,
        );
      }
      return { status: 0, stdout: output, stderr: "" };
    },
  };
  const modules = {
    "node:fs": fs,
    "node:path": path,
    "node:url": url,
    "node:crypto": crypto,
    "node:async_hooks": asyncHooks,
    "node:child_process": child,
    "node:net": {
      createServer() {
        return {
          once() {},
          listen(_port, _host, ready) {
            ready();
          },
          close(done) {
            done();
          },
        };
      },
    },
  };
  const module = new SourceTextModule(driverSource, {
    context,
    initializeImportMeta(meta) {
      meta.url = driverUrl.href;
    },
  });
  await module.link((specifier) => {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
          this.setExport(name, value);
      },
      { context },
    );
  });
  await module.evaluate();
  const id = await module.namespace.prepare();
  return {
    api: module.namespace,
    id,
    files,
    calls,
    images,
    state,
    diagnostics,
    checkpoint: () =>
      JSON.parse(
        [...files.entries()].find(([name]) =>
          name.endsWith("/checkpoint.json"),
        )[1],
      ),
  };
}

test("image preparation requires explicit permission and prepared stage before any child", async () => {
  const f = await fixture();
  await assert.rejects(
    f.api.main(["prepare-images", f.id]),
    /DOWNLOAD_PERMISSION_REQUIRED/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.api.main(["start", f.id]), /STAGE_ORDER/);
  assert.equal(f.calls.length, 0);
});

test("explicit image preparation attests every image and records a unique owned build", async () => {
  const f = await fixture();
  await f.api.main(["prepare-images", "--allow-downloads", f.id]);
  assert.equal(f.checkpoint().stage, "images-ready");
  assert.equal(Object.keys(f.checkpoint().images).length, 5);
  const build = f.calls.find(({ argv }) => argv.includes("build"));
  assert.ok(build);
  assert.ok(
    !f.calls.some(({ argv }) => argv.includes("up") || argv.includes("create")),
  );
  assert.equal(f.checkpoint().images.mlflow, `sha256:${"9".repeat(64)}`);
  const configuration = JSON.parse(
    [...f.files.entries()].find(([name]) =>
      name.endsWith("/docker/config.json"),
    )[1],
  );
  assert.deepEqual(configuration.auths, {
    "https://index.docker.io/v1/": {},
    "quay.io": {},
  });
  assert.equal(configuration.credsStore, "");
  assert.deepEqual(configuration.credHelpers, {});
  await assert.rejects(
    f.api.main(["prepare-images", "--allow-downloads", f.id]),
    /STAGE_ORDER/,
  );
});

test("cached build layers cannot adopt a preexisting image ID or missing nonce label", async () => {
  for (const defect of ["baseline", "nonce"]) {
    const f = await fixture();
    f.state.imageChange = (image, ref) => {
      if (!ref.startsWith("invoiceops-mlflow07:")) return;
      if (defect === "baseline") image.Id = f.images.get(refs[0]);
      else image.Config.Labels = {};
    };
    await assert.rejects(
      f.api.main(["prepare-images", "--allow-downloads", f.id]),
      /OWNERSHIP_MISMATCH/,
    );
    assert.notEqual(f.checkpoint().stage, "images-ready");
  }
});

test("failed build cannot grant cache-only startup permission", async () => {
  const f = await fixture();
  f.state.buildFails = true;
  await assert.rejects(
    f.api.main(["prepare-images", "--allow-downloads", f.id]),
    /COMMAND_FAILED/,
  );
  assert.notEqual(f.checkpoint().stage, "images-ready");
  f.calls.length = 0;
  await assert.rejects(f.api.main(["start", f.id]), /STAGE_ORDER/);
  assert.equal(f.calls.length, 0);
});

test("missing cached image fails before port preflight or resource mutation without pulls or builds", async () => {
  for (const selector of [...refs, "built"]) {
    const f = await fixture();
    await f.api.main(["prepare-images", "--allow-downloads", f.id]);
    f.calls.length = 0;
    f.state.missing =
      selector === "built" ? `invoiceops-mlflow07:${f.id}` : selector;
    await assert.rejects(f.api.main(["start", f.id]), /COMMAND_FAILED/);
    assert.ok(
      !f.calls.some(({ argv }) =>
        ["up", "create", "build", "pull", "rm"].some((word) =>
          argv.includes(word),
        ),
      ),
    );
  }
});

test("cache-only startup reaches up without builds or pulls and retains all five image identities", async () => {
  const f = await fixture();
  await f.api.main(["prepare-images", "--allow-downloads", f.id]);
  f.calls.length = 0;
  await f.api.main(["start", f.id]);
  assert.equal(f.checkpoint().stage, "started");
  assert.ok(f.calls.some(({ argv }) => argv.includes("up")));
  assert.ok(
    !f.calls.some(
      ({ argv }) => argv.includes("pull") || argv.includes("build"),
    ),
  );
  const firstMutation = f.calls.findIndex(({ argv }) =>
    argv.includes("create"),
  );
  assert.equal(
    f.calls
      .slice(0, firstMutation)
      .filter(({ argv }) => argv.includes("inspect") && argv.includes("image"))
      .length,
    5,
  );
});

test("changed or unowned cached images fail closed before runtime mutations", async () => {
  for (const defect of ["identity", "ownership"]) {
    const f = await fixture();
    await f.api.main(["prepare-images", "--allow-downloads", f.id]);
    f.calls.length = 0;
    f.state.imageChange = (image) => {
      if (defect === "identity") image.Id = `sha256:${"8".repeat(64)}`;
      else image.Config.Labels = {};
    };
    await assert.rejects(
      f.api.main(["start", f.id]),
      /IMAGE_CHANGED|OWNERSHIP_MISMATCH/,
    );
    assert.ok(
      !f.calls.some(({ argv }) =>
        ["up", "create", "build", "pull", "rm"].some((word) =>
          argv.includes(word),
        ),
      ),
    );
  }
});

test("untrusted public refs and build contexts fail before image downloads", async () => {
  for (const change of [
    (plan) => {
      plan.services.postgres.image = "private.invalid/postgres:latest";
    },
    (plan) => {
      plan.services.mlflow.build.context = "/untrusted";
    },
  ]) {
    const f = await fixture();
    f.state.configChange = change;
    await assert.rejects(
      f.api.main(["prepare-images", "--allow-downloads", f.id]),
      /IMAGE_CONFIG_CONTRACT/,
    );
    assert.ok(
      !f.calls.some(
        ({ argv }) => argv.includes("pull") || argv.includes("build"),
      ),
    );
  }
});

test("complete trusted image cache causes zero pulls but still builds the unique proof image", async () => {
  const f = await fixture();
  await f.api.main(["prepare-images", "--allow-downloads", f.id]);
  assert.equal(f.calls.filter(({ argv }) => argv.includes("pull")).length, 0);
  assert.equal(f.calls.filter(({ argv }) => argv.includes("build")).length, 1);
  assert.equal(f.checkpoint().stage, "images-ready");
  for (const ref of [...refs, pythonBase]) {
    assert.ok(
      f.calls.some(
        ({ argv }) => argv.includes("inspect") && argv.includes(ref),
      ),
    );
  }
});

test("only a confirmed missing trusted image can pull and only with explicit permission", async () => {
  for (const ref of [...refs, pythonBase]) {
    const f = await fixture();
    f.images.delete(ref);
    await assert.rejects(
      f.api.main(["prepare-images", f.id]),
      /DOWNLOAD_PERMISSION_REQUIRED/,
    );
    assert.equal(f.calls.length, 0);
    await f.api.main(["prepare-images", "--allow-downloads", f.id]);
    const pulls = f.calls.filter(({ argv }) => argv.includes("pull"));
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].argv.at(-1), ref);
    assert.equal(f.checkpoint().stage, "images-ready");
  }
});

test("local image query errors and ambiguous metadata never fall back to network", async () => {
  for (const defect of ["listing", "inspect", "ambiguous", "identity"]) {
    const f = await fixture();
    if (defect === "ambiguous")
      f.state.listingChange = (output) => `${output}\n${output}`;
    else if (defect === "identity")
      f.state.listingChange = () => `${refs[0]}|invalid-id`;
    else
      f.state.processFailure = (args) => {
        if (
          args[0] === "image" &&
          (defect === "listing"
            ? args.includes("{{.Repository}}:{{.Tag}}|{{.ID}}")
            : args[1] === "inspect")
        )
          return {
            status: 1,
            stdout: "private-stdout",
            stderr: "Cannot connect to the Docker daemon private-endpoint",
          };
      };
    await assert.rejects(
      f.api.main(["prepare-images", "--allow-downloads", f.id]),
    );
    assert.ok(
      !f.calls.some(
        ({ argv }) => argv.includes("pull") || argv.includes("build"),
      ),
    );
    assert.notEqual(f.checkpoint().stage, "images-ready");
    if (["listing", "inspect"].includes(defect)) {
      assert.equal(f.checkpoint().preparationFailure.step, "cache-postgres");
      assert.equal(
        f.checkpoint().preparationFailure.semanticCategory,
        "ENGINE_UNAVAILABLE",
      );
    }
  }
});

test("preparation failures identify the exact safe step without logs, URLs or private arguments", async () => {
  for (const [step, ref] of [
    ["pull-postgres", refs[0]],
    ["pull-minio", refs[1]],
    ["pull-minio-init", refs[2]],
    ["pull-python", pythonBase],
    ["build-mlflow", null],
  ]) {
    const f = await fixture();
    if (ref) f.images.delete(ref);
    f.state.processFailure = (args) => {
      if (ref ? args[0] === "pull" : args.includes("build"))
        return {
          status: 1,
          stdout: "private-stdout",
          stderr: "private-password https://private.invalid/raw-build-log",
        };
    };
    await assert.rejects(
      f.api.main(["prepare-images", "--allow-downloads", f.id]),
      /COMMAND_FAILED/,
    );
    const receipt = f.checkpoint().preparationFailure;
    assert.deepEqual(receipt, {
      step,
      category: "COMMAND_FAILED",
      semanticCategory: "UNCLASSIFIED",
    });
    assert.ok(
      f.diagnostics.some(
        (value) => JSON.stringify(value) === JSON.stringify(receipt),
      ),
    );
    assert.ok(!JSON.stringify(f.diagnostics).includes("private-"));
    assert.ok(!JSON.stringify(f.diagnostics).includes("https://"));
    const projection = f.api.preparationStatus(f.id);
    assert.deepEqual(
      JSON.parse(JSON.stringify(projection.preparationFailure)),
      receipt,
    );
    assert.ok(!JSON.stringify(projection).includes(f.checkpoint().appPassword));
    assert.equal(f.checkpoint().failure, "COMMAND_FAILED");
  }
});

test("bounded preparation error hints classify known signatures without retaining raw output", async () => {
  for (const [stderr, semanticCategory] of [
    ["pull access denied private-registry", "REGISTRY_ACCESS_DENIED"],
    ["toomanyrequests private-request", "REGISTRY_RATE_LIMIT"],
    ["lookup private-host: no such host", "NAME_RESOLUTION"],
    ["x509: private-certificate", "TLS_VERIFICATION"],
    ["no space left on device private-path", "DISK_FULL"],
    ["failed to solve: private-build-command", "BUILD_FAILED"],
  ]) {
    const f = await fixture();
    f.state.processFailure = (args) =>
      args.includes("build")
        ? { status: 1, stdout: "private-stdout", stderr }
        : null;
    await assert.rejects(
      f.api.main(["prepare-images", "--allow-downloads", f.id]),
      /COMMAND_FAILED/,
    );
    assert.equal(
      f.checkpoint().preparationFailure.semanticCategory,
      semanticCategory,
    );
    assert.equal(f.checkpoint().preparationFailure.step, "build-mlflow");
    assert.ok(!JSON.stringify(f.diagnostics).includes("private-"));
  }
});
