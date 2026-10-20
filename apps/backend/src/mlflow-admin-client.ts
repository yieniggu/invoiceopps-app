import {
  PROVISION_LIMITS,
  ProvisionError,
  requireCondition,
} from "./mlflow-provision-plan.js";

export interface AdminRequest {
  path: string;
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string>;
  body?: object;
  workspace?: string;
  missing?: boolean;
}
export interface MlflowAdminClient {
  request(
    input: AdminRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null>;
}
export function providerRecord(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
export function providerText(value: unknown): string {
  requireCondition(
    typeof value === "string" && value.length > 0 && value.length <= 255,
  );
  return value;
}
export function providerId(value: unknown): number {
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
  );
  return value;
}
export function providerList(
  data: Record<string, unknown>,
  field: string,
  limit: number,
): unknown[] {
  requireCondition(
    !data.next_page_token && !data.page_token && !data.truncated,
  );
  const list = data[field];
  requireCondition(Array.isArray(list));
  requireCondition(list.length <= limit, "LIMIT");
  return list;
}

export function createMlflowAdminClient(
  config: {
    mode: string;
    nodeEnv: string;
    baseUrl: string;
    username: string;
    password: string;
  },
  fetcher: typeof fetch = fetch,
): MlflowAdminClient {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new ProvisionError(503, "DISABLED");
  }
  if (
    config.mode !== "local-development" ||
    config.nodeEnv !== "development" ||
    base.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.pathname !== "/" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !config.username ||
    config.username.includes(":") ||
    !config.password
  )
    throw new ProvisionError(503, "DISABLED");
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  return {
    async request(input, outerSignal) {
      const url = new URL(input.path, base);
      if (url.origin !== base.origin || !input.path.startsWith("/api/"))
        throw new ProvisionError(503, "DISABLED");
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), PROVISION_LIMITS.callMs);
      const signal = AbortSignal.any([outerSignal, timeout.signal]);
      for (const [key, value] of Object.entries(input.query ?? {}))
        url.searchParams.set(key, value);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        signal.throwIfAborted();
        const response = await fetcher(url, {
          method: input.method ?? "GET",
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
            ...(input.workspace
              ? { "X-MLFLOW-WORKSPACE": input.workspace }
              : {}),
          },
          ...(input.body ? { body: JSON.stringify(input.body) } : {}),
          redirect: "manual",
          signal,
        });
        if (!response.body) throw new ProvisionError(502, "INVALID_PROVIDER");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1024 * 1024)
            throw new ProvisionError(502, "INVALID_PROVIDER");
          chunks.push(part.value);
        }
        if (response.status >= 300 && response.status < 400)
          throw new ProvisionError(502, "DEPENDENCY");
        const data = providerRecord(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        // Absence is recognized only by the provider's typed not-found contract.
        if (
          input.missing &&
          response.status === 404 &&
          data.error_code === "RESOURCE_DOES_NOT_EXIST"
        )
          return null;
        if (!response.ok) throw new ProvisionError(502, "DEPENDENCY");
        return data;
      } catch (error) {
        if (signal.aborted) throw new ProvisionError(503, "DEADLINE");
        if (error instanceof ProvisionError) throw error;
        throw new ProvisionError(502, "DEPENDENCY");
      } finally {
        clearTimeout(timer);
        // Cancellation errors must not replace the sanitized outcome above.
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
    },
  };
}
