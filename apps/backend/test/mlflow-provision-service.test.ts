import { describe, expect, it, vi } from "vitest";

import type {
  AdminRequest,
  MlflowAdminClient,
} from "../src/mlflow-admin-client.js";
import { createMlflowProvisionService } from "../src/mlflow-provision.js";
import {
  ProvisionError,
  type AcademicSnapshot,
} from "../src/mlflow-provision-plan.js";

const id = "11111111-1111-4111-8111-111111111111";
const group = "22222222-2222-4222-8222-222222222222";
const original: AcademicSnapshot = {
  slug: "data-academy",
  users: [{ id, rut: "123456785", role: "ADMIN" }],
  groups: [{ id: group, userIds: [id] }],
};

function fixture() {
  let current = structuredClone(original);
  let workspace = false;
  let nextId = 10;
  type Permission = {
    id: number;
    role_id: number;
    resource_type: string;
    resource_pattern: string;
    permission: string;
  };
  const users: Array<{ id: number; username: string; is_admin: boolean }> = [];
  const roles: Array<{
    id: number;
    name: string;
    workspace: string;
    permissions: Permission[];
  }> = [];
  const assignments: Array<{ id: number; user_id: number; role_id: number }> =
    [];
  const experiments = new Map<string, string>();
  const models = new Set<string>();
  const writes: AdminRequest[] = [];
  const request = vi.fn<MlflowAdminClient["request"]>(async (input) => {
    const body = input.body as Record<string, string | number> | undefined;
    if (!input.method || input.method === "GET") {
      if (input.path === "/api/2.0/mlflow/users/list") return { users };
      if (input.path.includes("workspaces/"))
        return workspace ? { workspace: { name: current.slug } } : null;
      if (input.path.endsWith("roles/list")) return { roles };
      if (input.path.endsWith("roles/users/list"))
        return {
          assignments: assignments.filter(
            (a) => String(a.role_id) === input.query?.role_id,
          ),
        };
      if (input.path.endsWith("experiments/get-by-name")) {
        const name = input.query!.experiment_name!;
        return experiments.has(name)
          ? {
              experiment: {
                name,
                experiment_id: experiments.get(name),
                lifecycle_stage: "active",
              },
            }
          : null;
      }
      if (input.path.endsWith("registered-models/get")) {
        const name = input.query!.name!;
        return models.has(name) ? { registered_model: { name } } : null;
      }
      throw new Error("Unexpected read");
    }
    writes.push(input);
    if (input.path.endsWith("workspaces")) {
      workspace = true;
      return { workspace: { name: body!.name } };
    }
    if (input.path.endsWith("users/create")) {
      const user = {
        id: nextId++,
        username: String(body!.username),
        is_admin: false,
      };
      users.push(user);
      return { user };
    }
    if (input.path.endsWith("experiments/create")) {
      const experiment_id = String(nextId++);
      experiments.set(String(body!.name), experiment_id);
      return { experiment_id };
    }
    if (input.path.endsWith("registered-models/create")) {
      models.add(String(body!.name));
      return { registered_model: { name: body!.name } };
    }
    if (input.path.endsWith("roles/create")) {
      const role = {
        id: nextId++,
        name: String(body!.name),
        workspace: current.slug,
        permissions: [],
      };
      roles.push(role);
      return { role };
    }
    if (input.path.endsWith("permissions/add")) {
      const permission = {
        id: nextId++,
        role_id: Number(body!.role_id),
        resource_type: String(body!.resource_type),
        resource_pattern: String(body!.resource_pattern),
        permission: String(body!.permission),
      };
      roles
        .find((r) => r.id === permission.role_id)!
        .permissions.push(permission);
      return { role_permission: permission };
    }
    if (input.path.endsWith("permissions/remove")) {
      for (const role of roles)
        role.permissions = role.permissions.filter(
          (p) => p.id !== body!.role_permission_id,
        );
      return {};
    }
    if (input.path.endsWith("roles/assign")) {
      const assignment = {
        id: nextId++,
        user_id: users.find((u) => u.username === body!.username)!.id,
        role_id: Number(body!.role_id),
      };
      assignments.push(assignment);
      return { assignment };
    }
    if (input.path.endsWith("roles/unassign")) {
      const user_id = users.find((u) => u.username === body!.username)!.id;
      const index = assignments.findIndex(
        (a) => a.user_id === user_id && a.role_id === body!.role_id,
      );
      if (index >= 0) assignments.splice(index, 1);
      return {};
    }
    throw new Error("Unexpected write");
  });
  const credentials = vi.fn(
    async () => new Map([["123456785", "synthetic-random-password-only"]]),
  );
  const snapshot = vi.fn(async () => structuredClone(current));
  let now = 0;
  const service = createMlflowProvisionService({
    client: { request },
    snapshot,
    credentials,
    now: () => now,
  });
  return {
    service,
    request,
    credentials,
    snapshot,
    writes,
    roles,
    assignments,
    users,
    experiments,
    models,
    advance: () => {
      now += 60_001;
    },
    change: (source: AcademicSnapshot) => {
      current = source;
    },
  };
}

describe("MLFLOW07 offline provider-boundary reconciliation", () => {
  it.each(["workspace", "grant", "assign"] as const)(
    "stops stale privilege additions after a change following %s",
    async (boundary) => {
      for (const change of [
        {
          ...original,
          users: [{ ...original.users[0]!, role: "STUDENT" as const }],
        },
        { ...original, groups: [] },
        { ...original, groups: [{ id: group, userIds: [] }] },
        { ...original, users: [], groups: [] },
      ]) {
        const f = fixture();
        const implementation = f.request.getMockImplementation()!;
        let changedAt = 0;
        f.request.mockImplementation(async (input, signal) => {
          const response = await implementation(input, signal);
          const matches =
            boundary === "workspace"
              ? input.path.endsWith("workspaces")
              : boundary === "grant"
                ? input.path.endsWith("permissions/add")
                : input.path.endsWith("roles/assign");
          if (matches && !changedAt) {
            f.change(change);
            changedAt = f.writes.length;
          }
          return response;
        });
        const result = await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: false,
        });
        expect.soft(result.httpStatus).toBe(503);
        expect.soft(result.body.code).toBe("SOURCE_CHANGED");
        expect.soft(result.body.status).toBe("partial");
        expect(result.body.unknownEffects).toBe(0);
        expect(changedAt).toBeGreaterThan(0);
        expect(
          f.writes
            .slice(changedAt)
            .filter(
              (input) =>
                input.path.endsWith("permissions/add") ||
                input.path.endsWith("roles/assign"),
            ),
        ).toEqual([]);
        expect(
          Object.values(result.body.confirmed).reduce((a, b) => a + b, 0),
        ).toBe(f.writes.length);
      }
    },
  );

  it("bounds source rechecks to the initial, pre-mutation and privilege operations", async () => {
    const f = fixture();
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(200);
    expect(f.snapshot).toHaveBeenCalledTimes(
      2 +
        result.body.planned.grant +
        result.body.planned.assign +
        result.body.planned.revoke +
        result.body.planned.unassign,
    );
    expect(f.request).toHaveBeenCalledTimes(2 + f.writes.length);
  });

  it("dry-run performs no mutations or credential-file reads", async () => {
    const f = fixture();
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: true,
    });
    expect(result.httpStatus).toBe(200);
    expect(f.writes).toHaveLength(0);
    expect(f.credentials).not.toHaveBeenCalled();
    expect(result.body.confirmed.user).toBe(0);
    expect(JSON.stringify(result)).not.toContain("123456785");
  });

  it("creates, repeats without writes, demotes and removes deleted-group memberships while preserving independent access", async () => {
    const f = fixture();
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: false,
        })
      ).httpStatus,
    ).toBe(200);
    const count = f.writes.length;
    f.advance();
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: false,
        })
      ).httpStatus,
    ).toBe(200);
    expect(f.writes).toHaveLength(count);
    expect(f.credentials).toHaveBeenCalledTimes(1);
    f.roles.push({
      id: 999,
      name: "manual-independent",
      workspace: original.slug,
      permissions: [],
    });
    f.assignments.push({ id: 999, user_id: f.users[0]!.id, role_id: 999 });
    f.change({
      ...original,
      users: [{ ...original.users[0]!, role: "STUDENT" }],
      groups: [],
    });
    f.advance();
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(200);
    expect(result.body.confirmed.unassign).toBe(2);
    expect(f.assignments.some((a) => a.role_id === 999)).toBe(true);
    expect(
      f.roles.find((r) => r.name === `group-${group}`)!.permissions,
    ).toEqual([]);
    expect(f.experiments.size).toBe(2);
    expect(f.models.size).toBe(2);
  });

  it("rejects missing credentials before the first mutation", async () => {
    const f = fixture();
    f.credentials.mockResolvedValue(new Map());
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(503);
    expect(result.body.code).toBe("CREDENTIALS");
    expect(f.writes).toHaveLength(0);
  });

  it("reports unknown effects separately from confirmed effects without retrying or leaking errors", async () => {
    const f = fixture();
    const implementation = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (input, signal) => {
      if (input.path.endsWith("users/create"))
        throw new Error("secret-password-raw-provider-url");
      return implementation(input, signal);
    });
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(502);
    expect(result.body.confirmed.workspace).toBe(1);
    expect(result.body.confirmed.user).toBe(0);
    expect(result.body.unknownEffects).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret-password");
    expect(
      f.request.mock.calls.filter(([input]) =>
        input.path.endsWith("users/create"),
      ),
    ).toHaveLength(1);
  });

  it("rejects incomplete inventories before mutations", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      users: [],
      next_page_token: "not-complete",
    });
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(502);
    expect(f.writes).toHaveLength(0);
  });

  it("enforces one active request and per-organization minute rate", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.snapshot.mockImplementationOnce(async () => {
      await blocked;
      return structuredClone(original);
    });
    const first = f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: true,
    });
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: "another-org",
          dryRun: true,
        })
      ).httpStatus,
    ).toBe(409);
    release!();
    expect((await first).httpStatus).toBe(200);
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: true,
        })
      ).httpStatus,
    ).toBe(429);
  });

  it("stops before revocation when the academic snapshot changes", async () => {
    const f = fixture();
    await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    f.advance();
    f.change({ ...original, groups: [] });
    const source = { ...original, groups: [] };
    f.snapshot
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(original);
    const before = f.writes.length;
    const result = await f.service.provision("actor", {
      organizationSlug: original.slug,
      dryRun: false,
    });
    expect(result.httpStatus).toBe(503);
    expect(result.body.code).toBe("SOURCE_CHANGED");
    expect(f.writes).toHaveLength(before);
  });

  it("authorizes the academic snapshot before privileged provider I/O", async () => {
    const f = fixture();
    f.snapshot.mockRejectedValue(new ProvisionError(403, "FORBIDDEN"));
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: true,
        })
      ).httpStatus,
    ).toBe(403);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("rejects an oversized academic source before provider I/O", async () => {
    const f = fixture();
    f.change({
      ...original,
      users: Array.from({ length: 101 }, () => original.users[0]!),
    });
    expect(
      (
        await f.service.provision("actor", {
          organizationSlug: original.slug,
          dryRun: false,
        })
      ).body.code,
    ).toBe("LIMIT");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.credentials).not.toHaveBeenCalled();
  });

  it("bounds the global deadline and classifies an interrupted mutation as unknown", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const implementation = f.request.getMockImplementation()!;
      let release: ((value: Record<string, unknown>) => void) | undefined;
      f.request.mockImplementation((input, signal) =>
        input.path.endsWith("users/create")
          ? new Promise((resolve) => {
              release = resolve;
            })
          : implementation(input, signal),
      );
      const pending = f.service.provision("actor", {
        organizationSlug: original.slug,
        dryRun: false,
      });
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await pending;
      expect(result.httpStatus).toBe(503);
      expect(result.body.code).toBe("DEADLINE");
      expect(result.body.unknownEffects).toBe(1);
      expect(result.body.confirmed.user).toBe(0);
      expect(result.body.confirmed.workspace).toBe(1);
      expect(
        (
          await f.service.provision("actor", {
            organizationSlug: "another-org",
            dryRun: true,
          })
        ).httpStatus,
      ).toBe(409);
      release!({ user: { id: 999, username: "123456785", is_admin: false } });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
