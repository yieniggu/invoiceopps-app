import type { ServiceEndpoint } from "./config.js";
import { isRecord, requestJson, ServiceUnreachableError } from "./http-json.js";

export interface RegisteredModelVersion {
  version: string;
  runId: string | null;
  /** ISO-8601, from MLflow's creation timestamp. */
  createdAt: string | null;
  /** Value of the `gate_status` tag, when the notebook set one. */
  gateStatus: string | null;
}

export interface RegisteredModelSummary {
  name: string;
  /** Newest first. */
  versions: RegisteredModelVersion[];
}

export interface RegisteredModels {
  models: RegisteredModelSummary[];
  /** True when MLflow had more versions than this read returns. */
  truncated: boolean;
}

/** MLflow (through the gateway) is down or refused the service identity. */
export class RegistryUnavailableError extends Error {
  constructor() {
    super("The MLflow registry is unavailable");
  }
}

export interface ModelRegistryClient {
  /**
   * Registered models of ONE workspace, read with the read-only service
   * identity. The workspace is built by the caller from the authorized
   * context, never from client input.
   */
  listModels(workspace: string): Promise<RegisteredModels>;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const MAX_VERSIONS_PER_MODEL = 20;
const TIMEOUT_MS = 10_000;

function timestampOf(value: unknown) {
  const millis = typeof value === "string" ? Number(value) : value;
  if (typeof millis !== "number" || !Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function gateStatusOf(tags: unknown) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (
      isRecord(tag) &&
      tag.key === "gate_status" &&
      typeof tag.value === "string"
    ) {
      return tag.value.slice(0, 32);
    }
  }
  return null;
}

export function createModelRegistryClient(
  endpoint: ServiceEndpoint,
): ModelRegistryClient {
  return {
    async listModels(workspace) {
      const byName = new Map<string, RegisteredModelVersion[]>();
      let pageToken: string | undefined;
      let truncated = false;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ max_results: String(PAGE_SIZE) });
        if (pageToken) query.set("page_token", pageToken);
        let result;
        try {
          result = await requestJson(
            "mlflow-gateway",
            `${endpoint.url}/api/2.0/mlflow/model-versions/search?${query}`,
            {
              method: "GET",
              headers: {
                Authorization: `Bearer ${endpoint.token}`,
                "X-InvoiceOps-Workspace": workspace,
              },
              timeoutMs: TIMEOUT_MS,
            },
          );
        } catch (error) {
          if (error instanceof ServiceUnreachableError) {
            throw new RegistryUnavailableError();
          }
          throw error;
        }
        if (result.status !== 200 || !isRecord(result.body)) {
          throw new RegistryUnavailableError();
        }
        const versions = result.body.model_versions;
        for (const item of Array.isArray(versions) ? versions : []) {
          if (
            !isRecord(item) ||
            typeof item.name !== "string" ||
            !/^[1-9][0-9]{0,8}$/.test(String(item.version))
          ) {
            continue;
          }
          const list = byName.get(item.name) ?? [];
          list.push({
            version: String(item.version),
            runId:
              typeof item.run_id === "string" && item.run_id !== ""
                ? item.run_id.slice(0, 64)
                : null,
            createdAt: timestampOf(item.creation_timestamp),
            gateStatus: gateStatusOf(item.tags),
          });
          byName.set(item.name, list);
        }
        const next = result.body.next_page_token;
        if (typeof next === "string" && next !== "") {
          pageToken = next;
          if (page === MAX_PAGES - 1) truncated = true;
        } else {
          break;
        }
      }
      const models = [...byName.entries()]
        .map(([name, versions]) => ({
          name,
          versions: versions
            .sort((a, b) => Number(b.version) - Number(a.version))
            .slice(0, MAX_VERSIONS_PER_MODEL),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { models, truncated };
    },
  };
}
