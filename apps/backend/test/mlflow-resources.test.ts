import { afterEach, describe, expect, it, vi } from "vitest";

import { createMlflowReadClient } from "../src/mlflow-read-client.js";
import { createMlflowResourceService } from "../src/mlflow-resources.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

afterEach(() => vi.useRealTimers());

const actor = {
  id: "a11ce000-0000-4000-8000-000000000001",
  name: "Ada Lovelace",
  rut: "123456785",
};
const context = {
  organizationId: "a11ce000-0000-4000-8000-000000000002",
  ownerType: "user" as const,
  ownerId: actor.id,
};

function persistence({ member = true } = {}) {
  const organizationMembership = {
    findUnique: vi.fn().mockResolvedValue(member ? { userId: actor.id } : null),
  };
  const organization = {
    findUnique: vi.fn().mockResolvedValue({ slug: "data-academy" }),
  };
  const user = {
    findUnique: vi.fn().mockResolvedValue({ rut: actor.rut }),
  };
  const group = { findFirst: vi.fn().mockResolvedValue(null) };
  const groupMembership = { findUnique: vi.fn().mockResolvedValue(null) };

  // Only the Prisma boundary is doubled; the orchestration remains real.
  const prisma = {
    organizationMembership,
    organization,
    user,
    group,
    groupMembership,
  } as unknown as PrismaClient;
  return { prisma, organizationMembership };
}

function reader() {
  return {
    getExperimentByName: vi.fn().mockResolvedValue({
      experimentId: "experiment-1",
      name: "student/123456785/invoice-risk",
    }),
    listRuns: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    getRegisteredModel: vi.fn().mockResolvedValue(null),
    listVersions: vi.fn().mockResolvedValue({ items: [], truncated: false }),
  };
}

describe("APP-09 live MLflow resource ownership", () => {
  it("rejects foreign organization and user contexts before any provider request", async () => {
    const { createMlflowResourceService } =
      await import("../src/mlflow-resources.js");
    for (const [input, member] of [
      [
        { ...context, organizationId: "a11ce000-0000-4000-8000-000000000003" },
        false,
      ],
      [{ ...context, ownerId: "a11ce000-0000-4000-8000-000000000004" }, true],
      [
        {
          ...context,
          ownerType: "group",
          ownerId: "a11ce000-0000-4000-8000-000000000005",
        },
        true,
      ],
    ] as const) {
      const { prisma, organizationMembership } = persistence({ member });
      const provider = reader();
      const service = createMlflowResourceService(prisma, provider);

      await expect(service.listResources(actor, input)).rejects.toMatchObject({
        status: 404,
      });
      expect(organizationMembership.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_organizationId: {
              userId: actor.id,
              organizationId: input.organizationId,
            },
          },
        }),
      );
      expect(provider.getExperimentByName).not.toHaveBeenCalled();
      expect(provider.listRuns).not.toHaveBeenCalled();
    }
  });

  it("derives the canonical experiment from the authorized user's RUT, not the owner UUID", async () => {
    const { createMlflowResourceService } =
      await import("../src/mlflow-resources.js");
    const { prisma } = persistence();
    const provider = reader();
    provider.listRuns.mockResolvedValue({
      items: [
        {
          runId: "own-run",
          experimentId: "experiment-1",
          tags: {
            organization_slug: "data-academy",
            owner_type: "user",
            owner_id: actor.id,
            created_by_rut: actor.rut,
          },
        },
      ],
      truncated: false,
    });

    const result = await createMlflowResourceService(
      prisma,
      provider,
    ).listResources(actor, context);

    // Adapter requests must carry the authorized workspace, never a global lookup.
    expect(provider.getExperimentByName).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "data-academy",
        name: "student/123456785/invoice-risk",
      }),
    );
    expect(provider.listRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "data-academy",
        experimentId: "experiment-1",
        organizationSlug: "data-academy",
        ownerType: "user",
        ownerId: actor.id,
        createdByRut: actor.rut,
      }),
    );
    expect(result.experiment).toMatchObject({
      id: "experiment-1",
      name: "student/123456785/invoice-risk",
    });
    expect(result.runs.map((run) => run.runId)).toEqual(["own-run"]);
  });

  it("excludes runs with foreign ownership even within the selected experiment", async () => {
    const { createMlflowResourceService } =
      await import("../src/mlflow-resources.js");
    const { prisma } = persistence();
    const provider = reader();
    provider.listRuns.mockResolvedValue({
      items: [
        {
          runId: "own-run",
          experimentId: "experiment-1",
          tags: {
            organization_slug: "data-academy",
            owner_type: "user",
            owner_id: actor.id,
            created_by_rut: actor.rut,
          },
        },
        {
          runId: "foreign-run",
          experimentId: "experiment-1",
          tags: {
            organization_slug: "other-academy",
            owner_type: "user",
            owner_id: "foreign-user",
            created_by_rut: "111111111",
          },
        },
        {
          runId: "wrong-experiment-run",
          experimentId: "experiment-2",
          tags: {
            organization_slug: "data-academy",
            owner_type: "user",
            owner_id: actor.id,
            created_by_rut: actor.rut,
          },
        },
      ],
      truncated: false,
    });

    const result = await createMlflowResourceService(
      prisma,
      provider,
    ).listResources(actor, context);

    expect(result.runs.map((run) => run.runId)).toEqual(["own-run"]);
  });

  it("uses the immutable group UUID and accepts group-created runs regardless of creator RUT", async () => {
    const { createMlflowResourceService } =
      await import("../src/mlflow-resources.js");
    const { prisma } = persistence();
    const groupId = "a11ce000-0000-4000-8000-000000000005";
    const groupPrisma = {
      ...prisma,
      group: { findFirst: vi.fn().mockResolvedValue({ id: groupId }) },
      groupMembership: {
        findUnique: vi.fn().mockResolvedValue({ userId: actor.id }),
      },
    } as unknown as PrismaClient;
    const provider = reader();
    provider.getExperimentByName.mockResolvedValue({
      experimentId: "experiment-2",
      name: `group/${groupId}/invoice-risk`,
    });
    provider.listRuns.mockResolvedValue({
      items: [
        {
          runId: "group-run",
          experimentId: "experiment-2",
          tags: {
            organization_slug: "data-academy",
            owner_type: "group",
            owner_id: groupId,
            created_by_rut: "111111111",
          },
        },
        {
          runId: "missing-creator",
          experimentId: "experiment-2",
          tags: {
            organization_slug: "data-academy",
            owner_type: "group",
            owner_id: groupId,
          },
        },
      ],
      truncated: true,
    });
    const result = await createMlflowResourceService(
      groupPrisma,
      provider,
    ).listResources(actor, {
      ...context,
      ownerType: "group",
      ownerId: groupId,
    });
    expect(provider.getExperimentByName).toHaveBeenCalledWith({
      workspace: "data-academy",
      name: `group/${groupId}/invoice-risk`,
    });
    expect(provider.listRuns).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: groupId, createdByRut: undefined }),
    );
    expect(result.runs).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("excludes a shared model and only exposes verified lineage on owned model versions", async () => {
    const { createMlflowResourceService } =
      await import("../src/mlflow-resources.js");
    const { prisma } = persistence();
    const provider = reader();
    provider.getRegisteredModel.mockResolvedValue({
      name: "invoice-review-production",
      tags: {},
    });
    let result = await createMlflowResourceService(
      prisma,
      provider,
    ).listResources(actor, context);
    expect(result.registeredModel).toBeNull();
    expect(provider.listVersions).not.toHaveBeenCalled();

    provider.getRegisteredModel.mockResolvedValue({
      name: "student-123456785-invoice-review",
      tags: {
        organization_slug: "data-academy",
        owner_type: "user",
        owner_id: actor.id,
        created_by_rut: actor.rut,
      },
    });
    provider.listRuns.mockResolvedValue({
      items: [
        {
          runId: "own-run",
          experimentId: "experiment-1",
          tags: {
            organization_slug: "data-academy",
            owner_type: "user",
            owner_id: actor.id,
            created_by_rut: actor.rut,
          },
        },
      ],
      truncated: false,
    });
    provider.listVersions.mockResolvedValue({
      items: [
        {
          name: "student-123456785-invoice-review",
          version: "1",
          runId: "own-run",
        },
        {
          name: "student-123456785-invoice-review",
          version: "2",
          runId: "foreign-run",
        },
        { name: "foreign-model", version: "3", runId: "own-run" },
      ],
      truncated: false,
    });
    result = await createMlflowResourceService(
      prisma,
      provider,
      "https://mlflow.example",
    ).listResources(actor, context);
    expect(result.versions).toEqual([
      {
        version: "1",
        runId: "own-run",
        url: "https://mlflow.example/#/models/student-123456785-invoice-review/versions/1?workspace=data-academy",
      },
      {
        version: "2",
        url: "https://mlflow.example/#/models/student-123456785-invoice-review/versions/2?workspace=data-academy",
      },
    ]);
  });

  it("bounds a stuck membership read and never starts subsequent DB or provider work after expiry", async () => {
    vi.useFakeTimers();
    let releaseMembership: ((value: { userId: string }) => void) | undefined;
    const pendingMembership = new Promise<{ userId: string }>((resolve) => {
      releaseMembership = resolve;
    });
    const { prisma } = persistence();
    const membership = vi.fn().mockReturnValue(pendingMembership);
    const findGroup = vi.fn();
    const findOrganization = vi.fn();
    const guardedPrisma = {
      ...prisma,
      organizationMembership: { findUnique: membership },
      group: { findFirst: findGroup },
      organization: { findUnique: findOrganization },
    } as unknown as PrismaClient;
    const provider = reader();
    const request = createMlflowResourceService(
      guardedPrisma,
      provider,
    ).listResources(actor, {
      ...context,
      ownerType: "group",
      ownerId: "a11ce000-0000-4000-8000-000000000005",
    });
    const assertion = expect(request).rejects.toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    releaseMembership?.({ userId: actor.id });
    await vi.advanceTimersByTimeAsync(0);
    expect(findGroup).not.toHaveBeenCalled();
    expect(findOrganization).not.toHaveBeenCalled();
    expect(provider.getExperimentByName).not.toHaveBeenCalled();
  });

  it("shares the DB time budget with a slow provider response body instead of restarting the deadline", async () => {
    vi.useFakeTimers();
    const { prisma } = persistence();
    const delayedPrisma = {
      ...prisma,
      organizationMembership: {
        findUnique: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ userId: actor.id }), 2_500);
            }),
        ),
      },
    } as unknown as PrismaClient;
    let bodyStarted = false;
    let bodyAborted = false;
    const fetcher = vi.fn(
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url =
          input instanceof URL
            ? input
            : new URL(input instanceof Request ? input.url : input.toString());
        const body = url.pathname.endsWith("/runs/search")
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                bodyStarted = true;
                controller.enqueue(new TextEncoder().encode('{"runs":['));
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    bodyAborted = true;
                    controller.error(new Error("aborted"));
                  },
                  { once: true },
                );
              },
            })
          : JSON.stringify(
              url.pathname.endsWith("/experiments/get-by-name")
                ? {
                    experiment: {
                      experiment_id: "experiment-1",
                      name: "student/123456785/invoice-risk",
                      lifecycle_stage: "active",
                    },
                  }
                : {},
            );
        return Promise.resolve(
          new Response(body, {
            status: url.pathname.endsWith("/registered-models/get") ? 404 : 200,
          }),
        );
      },
    );
    const client = createMlflowReadClient(
      {
        readUrl: "http://127.0.0.1:5000",
        uiUrl: "http://127.0.0.1:5000",
        username: "reader",
        password: "test-password",
      },
      fetcher,
    );
    const request = createMlflowResourceService(
      delayedPrisma,
      client,
    ).listResources(actor, context);
    const assertion = expect(request).rejects.toMatchObject({
      status: 503,
      code: "UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(bodyStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(bodyAborted).toBe(true);
  });
});
