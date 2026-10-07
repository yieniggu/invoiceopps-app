export class MlflowReadError extends Error {
  constructor(
    readonly status: 502 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}

type Tagged = { tags: Record<string, string> };
type Experiment = { experimentId: string; name: string };
type Run = Tagged & { runId: string; experimentId: string };
type RegisteredModel = Tagged & { name: string };
type Version = { name: string; version: string; runId?: string };
type Page<T> = { items: T[]; truncated: boolean };

async function withinDeadline<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new MlflowReadError(503, "UNAVAILABLE");
  let onAbort: () => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new MlflowReadError(503, "UNAVAILABLE"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), expired]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function withMlflowDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    return await withinDeadline(controller.signal, () =>
      work(controller.signal),
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export interface MlflowReader {
  getExperimentByName(input: {
    workspace: string;
    name: string;
  }): Promise<Experiment | null>;
  getRegisteredModel(input: {
    workspace: string;
    name: string;
  }): Promise<RegisteredModel | null>;
  listRuns(input: {
    workspace: string;
    experimentId: string;
    organizationSlug: string;
    ownerType: "user" | "group";
    ownerId: string;
    createdByRut?: string;
  }): Promise<Page<Run>>;
  listVersions(input: {
    workspace: string;
    name: string;
  }): Promise<Page<Version>>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MlflowReadError(502, "INVALID_RESPONSE");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new MlflowReadError(502, "INVALID_RESPONSE");
  }
  return value;
}

function tags(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) throw new MlflowReadError(502, "INVALID_RESPONSE");
  const result: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const item of value) {
    const tag = record(item);
    const key = text(tag.key);
    if (seen.has(key) || typeof tag.value !== "string")
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    seen.add(key);
    if (
      key === "organization_slug" ||
      key === "owner_type" ||
      key === "owner_id" ||
      key === "created_by_rut"
    ) {
      result[key] = tag.value;
    }
  }
  return result;
}

function quote(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function origin(raw: string) {
  const url = new URL(raw);
  if (
    (url.href !== `${url.origin}/` && url.href !== url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error("Invalid MLflow origin configuration");
  }
  return url.origin;
}

export function createMlflowReadClient(
  config: {
    readUrl: string;
    uiUrl: string;
    username: string;
    password: string;
  },
  fetcher: typeof fetch = fetch,
) {
  const readOrigin = origin(config.readUrl);
  const uiOrigin = origin(config.uiUrl);
  if (
    !config.username ||
    !config.password ||
    /[\r\n]/.test(config.username + config.password)
  ) {
    throw new Error("Invalid MLflow read credentials configuration");
  }
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;

  async function request(
    workspace: string,
    path: string,
    query?: URLSearchParams,
    body?: object,
    signal?: AbortSignal,
  ) {
    const url = new URL(`/api/2.0/mlflow/${path}`, readOrigin);
    if (query) url.search = query.toString();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal,
        headers: {
          Authorization: authorization,
          "X-MLFLOW-WORKSPACE": workspace,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new MlflowReadError(503, "UNAVAILABLE");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new MlflowReadError(503, "UNAVAILABLE");
    if (
      response.headers.get("content-length") &&
      Number(response.headers.get("content-length")) > 256 * 1024
    ) {
      await response.body?.cancel();
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    }
    if (!response.body) throw new MlflowReadError(502, "INVALID_RESPONSE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024)
          throw new MlflowReadError(502, "INVALID_RESPONSE");
        chunks.push(value);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof MlflowReadError) throw error;
      if (signal?.aborted) throw new MlflowReadError(503, "UNAVAILABLE");
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    } finally {
      reader.releaseLock();
      if (size > 256 * 1024) await response.body.cancel();
    }
  }

  async function bounded<T>(
    workspace: string,
    path: string,
    query: URLSearchParams | undefined,
    body: object | undefined,
    parse: (value: unknown) => T,
    field: string,
    signal: AbortSignal,
  ): Promise<Page<T>> {
    const data = await request(workspace, path, query, body, signal);
    if (!data) throw new MlflowReadError(503, "UNAVAILABLE");
    const items = data[field];
    if (items !== undefined && !Array.isArray(items))
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    if (items && items.length > 25)
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    if (
      data.next_page_token !== undefined &&
      typeof data.next_page_token !== "string"
    ) {
      throw new MlflowReadError(502, "INVALID_RESPONSE");
    }
    return {
      items: (items ?? []).map(parse),
      truncated: Boolean(data.next_page_token),
    };
  }

  // One deadline spans all calls and streamed bodies in one discovery.
  const client = {
    uiOrigin,
    withDeadline<T>(
      work: (reader: MlflowReader) => Promise<T>,
      existingSignal?: AbortSignal,
    ): Promise<T> {
      const run = (signal: AbortSignal) => {
        let calls = 0;
        const call = async <V>(action: () => Promise<V>): Promise<V> => {
          if (++calls > 4 || signal.aborted)
            throw new MlflowReadError(503, "UNAVAILABLE");
          return action();
        };
        const reader: MlflowReader = {
          async getExperimentByName({ workspace, name }) {
            return call(async () => {
              const data = await request(
                workspace,
                "experiments/get-by-name",
                new URLSearchParams({ experiment_name: name }),
                undefined,
                signal,
              );
              if (!data) return null;
              const exp = record(data.experiment);
              if (exp.lifecycle_stage === "deleted") return null;
              if (exp.lifecycle_stage !== "active") {
                throw new MlflowReadError(502, "INVALID_RESPONSE");
              }
              return {
                experimentId: text(exp.experiment_id),
                name: text(exp.name),
              };
            });
          },
          async getRegisteredModel({ workspace, name }) {
            return call(async () => {
              const data = await request(
                workspace,
                "registered-models/get",
                new URLSearchParams({ name }),
                undefined,
                signal,
              );
              if (!data) return null;
              const model = record(data.registered_model);
              return { name: text(model.name), tags: tags(model.tags ?? []) };
            });
          },
          listRuns(input) {
            const filters = [
              `tags.organization_slug = ${quote(input.organizationSlug)}`,
              `tags.owner_type = ${quote(input.ownerType)}`,
              `tags.owner_id = ${quote(input.ownerId)}`,
              ...(input.createdByRut
                ? [`tags.created_by_rut = ${quote(input.createdByRut)}`]
                : []),
            ];
            return call(() =>
              bounded(
                input.workspace,
                "runs/search",
                undefined,
                {
                  experiment_ids: [input.experimentId],
                  filter: filters.join(" AND "),
                  max_results: 25,
                  order_by: ["attributes.start_time DESC"],
                },
                (value) => {
                  const run = record(value);
                  const info = record(run.info);
                  const data = record(run.data);
                  return {
                    runId: text(info.run_id),
                    experimentId: text(info.experiment_id),
                    tags: tags(data.tags ?? []),
                  };
                },
                "runs",
                signal,
              ),
            );
          },
          listVersions({ workspace, name }) {
            return call(() =>
              bounded(
                workspace,
                "model-versions/search",
                new URLSearchParams({
                  filter: `name = ${quote(name)}`,
                  max_results: "25",
                }),
                undefined,
                (value) => {
                  const version = record(value);
                  return {
                    name: text(version.name),
                    version: text(version.version),
                    ...(version.run_id ? { runId: text(version.run_id) } : {}),
                  };
                },
                "model_versions",
                signal,
              ),
            );
          },
        };
        return withinDeadline(signal, () => work(reader));
      };
      return existingSignal ? run(existingSignal) : withMlflowDeadline(run);
    },
  };
  return client;
}
