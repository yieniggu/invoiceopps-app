import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMlflowReadClient,
  MlflowReadError,
} from "../src/mlflow-read-client.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function localServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

function client(readUrl: string) {
  return createMlflowReadClient({
    readUrl,
    uiUrl: readUrl,
    username: "reader",
    password: "test-password",
  });
}

describe("APP-09 bounded MLflow REST reader", () => {
  it("accepts valid long and empty non-ownership tags without leaking them into the resource DTO", async () => {
    const longValue = "x".repeat(8_000);
    const url = await localServer((request, response) => {
      const extra = [
        { key: "mlflow.note.content", value: "n".repeat(257) },
        { key: "mlflow.description", value: longValue },
        { key: "custom.empty", value: "" },
        ...Array.from({ length: 12 }, (_, index) => ({
          key: `custom.${index}`,
          value: longValue,
        })),
      ];
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.includes("runs/search")
            ? {
                runs: [
                  {
                    info: { run_id: "own-run", experiment_id: "1" },
                    data: {
                      tags: [{ key: "owner_id", value: "user-id" }, ...extra],
                    },
                  },
                ],
              }
            : {
                registered_model: {
                  name: "own-model",
                  tags: [{ key: "owner_type", value: "user" }, ...extra],
                },
              },
        ),
      );
    });
    const result = await client(url).withDeadline(async (reader) => ({
      model: await reader.getRegisteredModel({
        workspace: "academy",
        name: "own-model",
      }),
      runs: await reader.listRuns({
        workspace: "academy",
        experimentId: "1",
        organizationSlug: "academy",
        ownerType: "user",
        ownerId: "user-id",
      }),
    }));
    expect(result.model?.tags.owner_type).toBe("user");
    expect(result.runs.items[0].tags.owner_id).toBe("user-id");
    expect(result.model?.tags["mlflow.description"]).toBeUndefined();
    expect(result.runs.items[0].tags["custom.empty"]).toBeUndefined();
  });

  it("rejects duplicate ownership tags and non-string values", async () => {
    for (const tags of [
      [
        { key: "owner_id", value: "own" },
        { key: "owner_id", value: "foreign" },
      ],
      [{ key: "owner_id", value: { unsafe: true } }],
    ]) {
      const url = await localServer((_request, response) =>
        response.end(
          JSON.stringify({ registered_model: { name: "own-model", tags } }),
        ),
      );
      await expect(
        client(url).withDeadline((reader) =>
          reader.getRegisteredModel({
            workspace: "academy",
            name: "own-model",
          }),
        ),
      ).rejects.toEqual(new MlflowReadError(502, "INVALID_RESPONSE"));
    }
  });

  it("uses exact workspace-scoped GET and POST endpoints with Basic auth and bounded filters", async () => {
    const calls: Array<{
      path: string;
      method: string;
      workspace: string;
      auth: string;
      body: string;
    }> = [];
    const url = await localServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({
          path: request.url!,
          method: request.method!,
          workspace: String(request.headers["x-mlflow-workspace"]),
          auth: String(request.headers.authorization),
          body: Buffer.concat(chunks).toString(),
        });
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify(
            request.url?.includes("get-by-name")
              ? {
                  experiment: {
                    experiment_id: "123",
                    name: "student/123456785/invoice-risk",
                    lifecycle_stage: "active",
                  },
                }
              : request.url?.includes("registered-models/get")
                ? {
                    registered_model: {
                      name: "student-123456785-invoice-review",
                      tags: [{ key: "owner_type", value: "user" }],
                    },
                  }
                : request.url?.includes("runs/search")
                  ? {
                      runs: [
                        {
                          info: { run_id: "run-1", experiment_id: "123" },
                          data: {
                            tags: [{ key: "owner_id", value: "user-id" }],
                          },
                        },
                      ],
                      next_page_token: "more",
                    }
                  : {
                      model_versions: [
                        {
                          name: "student-123456785-invoice-review",
                          version: "1",
                          run_id: "run-1",
                        },
                      ],
                    },
          ),
        );
      });
    });
    const result = await client(url).withDeadline(async (reader) => {
      const exp = await reader.getExperimentByName({
        workspace: "academy",
        name: "student/123456785/invoice-risk",
      });
      const model = await reader.getRegisteredModel({
        workspace: "academy",
        name: "student-123456785-invoice-review",
      });
      const runs = await reader.listRuns({
        workspace: "academy",
        experimentId: "123",
        organizationSlug: "academy",
        ownerType: "user",
        ownerId: "user-id",
        createdByRut: "123456785",
      });
      const versions = await reader.listVersions({
        workspace: "academy",
        name: "student-123456785-invoice-review",
      });
      return { exp, model, runs, versions };
    });
    expect(result.exp?.experimentId).toBe("123");
    expect(result.model?.tags.owner_type).toBe("user");
    expect(result.runs).toMatchObject({
      truncated: true,
      items: [{ runId: "run-1" }],
    });
    expect(result.versions.items[0].version).toBe("1");
    expect(calls).toHaveLength(4);
    expect(
      calls.every(
        (call) =>
          call.workspace === "academy" &&
          call.auth === "Basic cmVhZGVyOnRlc3QtcGFzc3dvcmQ=",
      ),
    ).toBe(true);
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/2.0/mlflow/experiments/get-by-name?experiment_name=student%2F123456785%2Finvoice-risk",
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/api/2.0/mlflow/runs/search",
    });
    expect(JSON.parse(calls[2].body)).toMatchObject({
      experiment_ids: ["123"],
      max_results: 25,
    });
    expect(calls[2].body).toContain("tags.created_by_rut");
    expect(calls[3].path).toContain("max_results=25");
  });

  it("rejects unauthorized provider responses rather than returning an empty catalog", async () => {
    const url = await localServer((_request, response) => {
      response.writeHead(401).end();
    });
    await expect(
      client(url).withDeadline((reader) =>
        reader.getExperimentByName({ workspace: "academy", name: "own" }),
      ),
    ).rejects.toEqual(new MlflowReadError(503, "UNAVAILABLE"));
  });

  it("rejects malformed, over-limit and redirect responses without following them", async () => {
    for (const kind of ["malformed", "oversize", "redirect"]) {
      const url = await localServer((_request, response) => {
        if (kind === "redirect") {
          response
            .writeHead(302, { Location: "https://example.invalid/steal" })
            .end();
          return;
        }
        response.end(
          kind === "malformed"
            ? "not json"
            : JSON.stringify({ data: "x".repeat(256 * 1024) }),
        );
      });
      await expect(
        client(url).withDeadline((reader) =>
          reader.getExperimentByName({ workspace: "academy", name: "own" }),
        ),
      ).rejects.toMatchObject({ status: kind === "redirect" ? 503 : 502 });
    }
  });

  it("rejects external HTTP, embedded credentials and non-origin paths before sending requests", () => {
    for (const url of [
      "http://mlflow.example",
      "https://reader:secret@mlflow.example",
      "https://mlflow.example/path",
      "https://mlflow.example/#x",
    ]) {
      expect(() => client(url)).toThrow();
    }
  });

  it("enforces the total deadline even if a transport never settles", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    const reader = createMlflowReadClient(
      {
        readUrl: "http://127.0.0.1:5000",
        uiUrl: "http://127.0.0.1:5000",
        username: "reader",
        password: "test-password",
      },
      hanging,
    );
    const pending = reader.withDeadline((active) =>
      active.getExperimentByName({ workspace: "academy", name: "own" }),
    );
    const assertion = expect(pending).rejects.toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});
