import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Fake Model API and fake MLflow gateway for the MLOPS-05 tests: real HTTP
// servers on a loopback port, so the production clients (fetch, headers,
// timeouts, error mapping) run unchanged.

export const MODEL_API_TOKEN = "t".repeat(40);
export const GATEWAY_TOKEN = "g".repeat(40);

export interface RecordedCall {
  method: string;
  path: string;
  authorization: string | undefined;
  workspace: string | undefined;
  body: unknown;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export const AUC_REASON = {
  code: "AUC_BELOW_MIN",
  message: "AUC 0.61 is below the minimum 0.70",
  detail: { auc: 0.61, minAuc: 0.7 },
};

export type PutMode =
  | "pass"
  | "fail"
  | "down"
  | "capacity"
  | "slow"
  /** Loads the model, then answers only after a long pause (client times out). */
  | "load-then-hang";

export type PredictMode =
  | "ok"
  | "unavailable"
  | "invalid"
  /** 503 BUSY: the download gate of the Model API is full. */
  | "busy"
  /** 413: the body is over the Model API limit. */
  | "too-large"
  /** 422 INVALID_REQUEST: a field is out of range. */
  | "out-of-range"
  /** A plain 500 without a code: the service answered, with an error. */
  | "error";

export interface FakeModelApi {
  url: string;
  calls: RecordedCall[];
  /** deploymentId -> reference currently loaded. */
  loaded: Map<string, Record<string, string>>;
  quarantined: Set<string>;
  putMode: PutMode;
  /**
   * While set, every PUT /deployments/{id} waits for it before answering: a
   * test holds a gate run open, does something meanwhile, then resolves it.
   */
  putGate: Promise<void> | null;
  /** How POST /deployments/{id}/predict answers (MLOPS-06). */
  predictMode: PredictMode;
  probability: number;
  /** Pause before a predict answer, to widen race windows in tests. */
  predictDelayMs: number;
  /**
   * One-shot: the NEXT predict request waits for it before answering (later
   * ones are not held). The answer carries the probability that was set when
   * the request arrived.
   */
  predictGate: Promise<void> | null;
  /** When true every route answers 502 (the whole service is down). */
  down: boolean;
  runId: string;
  close(): Promise<void>;
}

export async function startFakeModelApi(): Promise<FakeModelApi> {
  const fake: FakeModelApi = {
    url: "",
    calls: [],
    loaded: new Map(),
    quarantined: new Set(),
    putMode: "pass",
    putGate: null,
    predictMode: "ok",
    probability: 0.37,
    predictDelayMs: 0,
    predictGate: null,
    down: false,
    runId: "run-0001",
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const body = await readJson(request);
    fake.calls.push({
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      workspace: undefined,
      body,
    });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.headers.authorization !== `Bearer ${MODEL_API_TOKEN}`) {
      send(401, { detail: { code: "UNAUTHORIZED" } });
      return;
    }
    if (fake.down) {
      send(502, { detail: { code: "MLFLOW_UNAVAILABLE" } });
      return;
    }
    const match = /^\/deployments\/([^/]+)$/.exec(path);
    if (request.method === "GET" && path === "/deployments") {
      send(200, {
        status: "ok",
        deployments: [...fake.loaded].map(([deploymentId, ref]) => ({
          deploymentId,
          ...ref,
          runId: fake.runId,
          loadedAt: "2026-11-01T00:00:00Z",
          metrics: {},
        })),
        quarantined: [...fake.quarantined].map((deploymentId) => ({
          deploymentId,
          reason: "worker crashed",
        })),
      });
      return;
    }
    if (request.method === "PUT" && match) {
      const ref = body as Record<string, string>;
      if (fake.putMode === "down") {
        send(503, { detail: { code: "GATE_UNAVAILABLE" } });
        return;
      }
      if (fake.putMode === "capacity") {
        send(409, { detail: { code: "CAPACITY_EXCEEDED", capacity: 30 } });
        return;
      }
      if (fake.putGate) await fake.putGate;
      if (fake.putMode === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (fake.putMode === "load-then-hang") {
        fake.loaded.set(match[1]!, ref);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (fake.putMode === "fail") {
        send(422, {
          detail: {
            code: "GATE_FAILED",
            passed: false,
            reasons: [AUC_REASON],
            metrics: {
              auc: 0.61,
              dummyAuc: 0.5,
              lift: 0.11,
              minAuc: 0.7,
              minLift: 0.02,
              validationRows: 4000,
            },
            featureSchemaVersion: "invoice-features-v2",
            model: { ...ref, runId: fake.runId },
          },
        });
        return;
      }
      fake.loaded.set(match[1]!, ref);
      fake.quarantined.delete(match[1]!);
      send(200, {
        deploymentId: match[1],
        ...ref,
        runId: fake.runId,
        loadedAt: "2026-11-01T00:00:00Z",
        metrics: {
          auc: 0.82,
          dummyAuc: 0.5,
          lift: 0.32,
          minAuc: 0.7,
          minLift: 0.02,
          validationRows: 4000,
        },
      });
      return;
    }
    const predict = /^\/deployments\/([^/]+)\/predict$/.exec(path);
    if (request.method === "POST" && predict) {
      const probability = fake.probability;
      if (fake.predictGate) {
        const gate = fake.predictGate;
        fake.predictGate = null;
        await gate;
      }
      if (fake.predictDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, fake.predictDelayMs),
        );
      }
      const ref = fake.loaded.get(predict[1]!);
      if (!ref) {
        send(404, { detail: { code: "DEPLOYMENT_NOT_LOADED" } });
        return;
      }
      if (fake.predictMode === "unavailable") {
        send(503, { detail: { code: "INFERENCE_UNAVAILABLE" } });
        return;
      }
      if (fake.predictMode === "error") {
        send(500, { detail: { code: "INTERNAL" } });
        return;
      }
      if (fake.predictMode === "busy") {
        send(503, { detail: { code: "BUSY", message: "retry shortly" } });
        return;
      }
      if (fake.predictMode === "too-large") {
        send(413, { detail: { code: "PAYLOAD_TOO_LARGE" } });
        return;
      }
      if (fake.predictMode === "out-of-range") {
        send(422, { detail: { code: "INVALID_REQUEST", issues: [] } });
        return;
      }
      if (fake.predictMode === "invalid") {
        send(422, { detail: [{ msg: "invalid" }] });
        return;
      }
      send(200, {
        deploymentId: predict[1],
        workspace: ref.workspace,
        registeredModel: ref.registeredModel,
        modelVersion: ref.version,
        runId: fake.runId,
        featureSchemaVersion: "invoice-features-v2",
        probability,
      });
      return;
    }
    if (request.method === "DELETE" && match) {
      const unloaded = fake.loaded.delete(match[1]!);
      send(200, { deploymentId: match[1], unloaded });
      return;
    }
    send(404, { detail: { code: "NOT_FOUND" } });
  });
  fake.url = await listen(server);
  return fake;
}

export interface FakeGatewayVersion {
  name: string;
  version: string;
  run_id?: string;
  creation_timestamp?: string;
  tags?: Array<{ key: string; value: string }>;
}

export interface FakeGateway {
  url: string;
  calls: RecordedCall[];
  /** workspace -> versions */
  versions: Map<string, FakeGatewayVersion[]>;
  down: boolean;
  close(): Promise<void>;
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const fake: FakeGateway = {
    url: "",
    calls: [],
    versions: new Map(),
    down: false,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server = createServer((request, response) => {
    const workspace = request.headers["x-invoiceops-workspace"] as
      string | undefined;
    fake.calls.push({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      workspace,
      body: undefined,
    });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.headers.authorization !== `Bearer ${GATEWAY_TOKEN}`) {
      send(401, { error: "unauthenticated" });
      return;
    }
    if (fake.down) {
      send(502, { error: "upstream" });
      return;
    }
    if (
      (request.url ?? "").startsWith("/api/2.0/mlflow/model-versions/search")
    ) {
      send(200, { model_versions: fake.versions.get(workspace ?? "") ?? [] });
      return;
    }
    send(404, { error: "not found" });
  });
  return listen(server).then((url) => {
    fake.url = url;
    return fake;
  });
}
