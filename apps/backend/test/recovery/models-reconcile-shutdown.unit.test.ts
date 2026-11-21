import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  createModelApiClient,
  ModelApiUnavailableError,
  type ModelApiClient,
} from "../../src/features/models/model-api-client.js";
import {
  createModelsService,
  MAX_EAGER_RELOADS,
  RECONCILE_UNAVAILABLE_WARN_INTERVAL_MS,
} from "../../src/features/models/services.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function prismaStub(overrides: Record<string, unknown> = {}) {
  return {
    $transaction: async (run: (tx: unknown) => unknown) =>
      run({ deployment: { findMany: async () => [] } }),
    deployment: {
      findMany: async () => IDS.map((id) => ({ id })),
      findUnique: async (args: { where: { id: string } }) => ({
        id: args.where.id,
        organizationId: "org-1",
        groupId: null,
        workspace: "org-org-1",
        registeredModel: "invoice-risk",
        version: "3",
        status: "ACTIVE",
        organization: { mlEnabled: true },
      }),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

/** Resolves when the signal fires, like the real client's fetch. */
function hangUntilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new ModelApiUnavailableError("aborted")),
      { once: true },
    );
  });
}

describe("models reconcile during shutdown (CR-517)", () => {
  it("returns quickly when the Model API never answers GET /deployments", async () => {
    // A real client against a server that holds the request open forever.
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const modelApi = createModelApiClient({
      url: `http://127.0.0.1:${port}`,
      token: "t".repeat(40),
    });
    const service = createModelsService(prismaStub(), { modelApi });

    const shutdown = new AbortController();
    const started = Date.now();
    const pass = service.reconcile({ signal: shutdown.signal });
    setTimeout(() => shutdown.abort(), 50);
    const result = await pass;

    // The client's own timeout is 10 s: finishing fast proves the signal.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ modelApiAvailable: false, reloaded: 0 });
  });

  it("aborts an eager reload in flight and does not start the next ones", async () => {
    const deploy = vi.fn(
      (_id: string, _ref: unknown, options?: { signal?: AbortSignal }) =>
        hangUntilAborted(options?.signal),
    );
    const modelApi = {
      state: vi.fn(async () => ({
        loaded: new Set<string>(),
        quarantined: new Set<string>(),
      })),
      unload: vi.fn(async () => undefined),
      deploy,
    } as unknown as ModelApiClient;
    const service = createModelsService(prismaStub(), { modelApi });

    const shutdown = new AbortController();
    const started = Date.now();
    const pass = service.reconcile({ signal: shutdown.signal });
    setTimeout(() => shutdown.abort(), 50);
    const result = await pass;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.reloaded).toBe(0);
    // Every started reload received the shutdown signal...
    for (const call of deploy.mock.calls) {
      expect(call[2]?.signal).toBe(shutdown.signal);
    }
    // ...and the lanes stopped taking jobs once it fired.
    expect(deploy.mock.calls.length).toBeLessThanOrEqual(IDS.length);
  });

  it("does not log an aborted unload as a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const modelApi = {
      state: vi.fn(async () => ({
        loaded: new Set(IDS),
        quarantined: new Set<string>(),
      })),
      unload: vi.fn((_id: string, options?: { signal?: AbortSignal }) =>
        hangUntilAborted(options?.signal),
      ),
      deploy: vi.fn(),
    } as unknown as ModelApiClient;
    const prisma = prismaStub({
      deployment: {
        // Orphans: no row owns them, so reconcile unloads each one.
        findMany: async () => [],
      },
    });
    const service = createModelsService(prisma, { modelApi });

    const shutdown = new AbortController();
    const pass = service.reconcile({ signal: shutdown.signal });
    setTimeout(() => shutdown.abort(), 50);
    await pass;

    expect(modelApi.unload).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("models reconcile fairness (round-robin eager reload)", () => {
  it("retries every lost deployment over successive passes, not always the first 20", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const total = MAX_EAGER_RELOADS * 2 + 5;
    const ids = Array.from(
      { length: total },
      (_, index) =>
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    );
    const attempts: string[][] = [];
    let current: string[] = [];
    const modelApi = {
      state: vi.fn(async () => ({
        loaded: new Set<string>(),
        quarantined: new Set<string>(),
      })),
      unload: vi.fn(async () => undefined),
      // Always down: nothing ever loads, so without round-robin the same
      // first MAX_EAGER_RELOADS ids would be retried on every pass.
      deploy: vi.fn(async (id: string) => {
        current.push(id);
        throw new ModelApiUnavailableError();
      }),
    } as unknown as ModelApiClient;
    const prisma = prismaStub({
      deployment: {
        findMany: async () => ids.map((id) => ({ id })),
        findUnique: async (args: { where: { id: string } }) => ({
          id: args.where.id,
          organizationId: "org-1",
          groupId: null,
          workspace: "org-org-1",
          registeredModel: "invoice-risk",
          version: "3",
          status: "ACTIVE",
          organization: { mlEnabled: true },
        }),
      },
    });
    const service = createModelsService(prisma, { modelApi });

    for (let pass = 0; pass < 3; pass += 1) {
      current = [];
      await service.reconcile();
      attempts.push(current);
    }

    expect(attempts[0]).toHaveLength(MAX_EAGER_RELOADS);
    // Pass 2 starts with the ids pass 1 never reached.
    expect(attempts[1]!.slice(0, 5).sort()).toEqual(
      ids.slice(MAX_EAGER_RELOADS, MAX_EAGER_RELOADS + 5).sort(),
    );
    expect(new Set(attempts.flat())).toEqual(new Set(ids));
  });
});

describe("models reconcile with the Model API down (CR-534)", () => {
  function unavailableService(clock: { value: number }) {
    const modelApi = {
      state: vi.fn(async () => {
        throw new ModelApiUnavailableError();
      }),
      unload: vi.fn(),
      deploy: vi.fn(),
    } as unknown as ModelApiClient;
    return createModelsService(prismaStub(), {
      modelApi,
      now: () => new Date(clock.value),
    });
  }

  const unavailableWarnings = (
    warn: MockInstance<(...args: unknown[]) => void>,
  ) =>
    warn.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.event === "models.reconcile_unavailable");

  it("logs one warning per interval, however many passes run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clock = { value: 1_000_000 };
    const service = unavailableService(clock);

    for (let pass = 0; pass < 5; pass += 1) {
      const result = await service.reconcile();
      expect(result.modelApiAvailable).toBe(false);
      clock.value += 10_000;
    }
    expect(unavailableWarnings(warn)).toHaveLength(1);
    expect(unavailableWarnings(warn)[0]).toMatchObject({
      level: "warn",
      feature: "models",
    });

    clock.value += RECONCILE_UNAVAILABLE_WARN_INTERVAL_MS;
    await service.reconcile();
    expect(unavailableWarnings(warn)).toHaveLength(2);
  });

  it("does not warn when the pass was cut short by shutdown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = unavailableService({ value: 1_000_000 });
    const shutdown = new AbortController();
    shutdown.abort();
    await service.reconcile({ signal: shutdown.signal });
    expect(unavailableWarnings(warn)).toHaveLength(0);
  });
});
