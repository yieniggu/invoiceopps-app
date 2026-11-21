import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createModelsService } from "../../src/features/models/services.js";
import type { ModelApiClient } from "../../src/features/models/model-api-client.js";

const ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    organizationId: "org-1",
    groupId: null,
    workspace: "org-org-1",
    registeredModel: "invoice-risk",
    version: "3",
    status: "ACTIVE",
    organization: { mlEnabled: true },
    ...overrides,
  };
}

function build(options: { deployDelayMs?: number; mlEnabled?: boolean } = {}) {
  const deploy = vi.fn(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, options.deployDelayMs ?? 20),
    );
    return { kind: "loaded" as const, report: {} as never };
  });
  const state = vi.fn(async () => ({
    loaded: new Set<string>(),
    quarantined: new Set<string>(),
  }));
  const modelApi = { deploy, state } as unknown as ModelApiClient;
  const prisma = {
    deployment: {
      findUnique: vi.fn(async () =>
        row({ organization: { mlEnabled: options.mlEnabled ?? true } }),
      ),
    },
  } as unknown as PrismaClient;
  return { service: createModelsService(prisma, { modelApi }), deploy };
}

describe("ensureLoaded single flight (CR-503)", () => {
  it("runs one reload for any number of concurrent callers of a deployment", async () => {
    const { service, deploy } = build();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.ensureLoaded(ID)),
    );

    expect(results).toEqual(Array(8).fill("loaded"));
    expect(deploy).toHaveBeenCalledTimes(1);
  });

  it("does not cache the outcome: a later call reloads again", async () => {
    const { service, deploy } = build({ deployDelayMs: 1 });

    await service.ensureLoaded(ID);
    await service.ensureLoaded(ID);

    expect(deploy).toHaveBeenCalledTimes(2);
  });

  it("shares a failure with the waiting callers and then recovers", async () => {
    const { service, deploy } = build({ deployDelayMs: 5 });
    deploy.mockRejectedValueOnce(new Error("boom"));

    const outcomes = await Promise.allSettled([
      service.ensureLoaded(ID),
      service.ensureLoaded(ID),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(await service.ensureLoaded(ID)).toBe("loaded");
  });

  it("never reloads while the organization's Models section is off", async () => {
    const { service, deploy } = build({ mlEnabled: false });

    expect(await service.ensureLoaded(ID)).toBe("not_active");
    expect(deploy).not.toHaveBeenCalled();
  });
});
