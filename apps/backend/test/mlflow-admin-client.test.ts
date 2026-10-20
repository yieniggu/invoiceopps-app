import { describe, expect, it, vi } from "vitest";

import { createMlflowAdminClient } from "../src/mlflow-admin-client.js";

const config = {
  mode: "local-development",
  nodeEnv: "development",
  baseUrl: "http://127.0.0.1:5000",
  username: "synthetic-admin",
  password: "synthetic-admin-only",
};

describe("MLFLOW07 privileged transport", () => {
  it("rejects remote, redirectable and implicitly enabled configuration before fetch", () => {
    for (const overrides of [
      { baseUrl: "https://mlflow.example.test" },
      { nodeEnv: "production" },
      { mode: "" },
      { baseUrl: "http://localhost:5000" },
      { baseUrl: "http://127.0.0.1:5000/path" },
    ]) {
      expect(() =>
        createMlflowAdminClient({ ...config, ...overrides }),
      ).toThrow();
    }
  });

  it("sends explicit workspace and manual redirects using a separate admin identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"roles":[]}'));
    const client = createMlflowAdminClient(config, fetcher);
    await client.request(
      {
        path: "/api/3.0/mlflow/roles/list",
        query: { workspace: "data-academy" },
        workspace: "data-academy",
      },
      AbortSignal.timeout(1000),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, options] = fetcher.mock.calls[0]!;
    expect(options?.redirect).toBe("manual");
    expect(new Headers(options?.headers).get("X-MLFLOW-WORKSPACE")).toBe(
      "data-academy",
    );
  });

  it("does not follow or retry redirects and never exposes provider bodies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("raw-provider-secret", {
        status: 302,
        headers: { Location: "https://untrusted.example.test" },
      }),
    );
    const client = createMlflowAdminClient(config, fetcher);
    await expect(
      client.request(
        { path: "/api/2.0/mlflow/users/list" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("DEPENDENCY");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized streamed responses and incomplete listings", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    const client = createMlflowAdminClient(config, fetcher);
    await expect(
      client.request(
        { path: "/api/2.0/mlflow/users/list" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
  });

  it("recognizes only typed missing-resource errors, not arbitrary HTTP 404s", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error_code":"RESOURCE_DOES_NOT_EXIST"}', {
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"message":"unknown route"}', { status: 404 }),
      );
    const client = createMlflowAdminClient(config, fetcher);
    const input = {
      path: "/api/3.0/mlflow/workspaces/data-academy",
      missing: true,
    };
    expect(await client.request(input, AbortSignal.timeout(1000))).toBeNull();
    await expect(
      client.request(input, AbortSignal.timeout(1000)),
    ).rejects.toThrow("DEPENDENCY");
  });

  it("enforces the five-second per-call timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          ),
      );
      const client = createMlflowAdminClient(config, fetcher);
      const outcome = client
        .request(
          { path: "/api/2.0/mlflow/users/list" },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5001);
      expect(await outcome).toMatchObject({ code: "DEADLINE", status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
