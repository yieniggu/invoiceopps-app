import { randomUUID } from "node:crypto";

import type { PrismaClient } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import {
  providerId,
  providerList,
  providerRecord,
  providerText,
  type AdminRequest,
  type MlflowAdminClient,
} from "./mlflow-admin-client.js";
import {
  buildProvisionPlan,
  emptyCounts,
  EXPERIMENT_ID,
  managedRole,
  PROVISION_LIMITS,
  ProvisionError,
  requireCondition,
  validateSnapshot,
  WORKSPACE,
  type AcademicSnapshot,
  type OperationCounts,
  type ProvisionInventory,
  type ProvisionOperation,
} from "./mlflow-provision-plan.js";

export interface ProvisionInput {
  organizationSlug: string;
  dryRun: boolean;
}
export interface ProvisionResult {
  httpStatus: number;
  body: {
    status: "ok" | "error" | "partial";
    correlationId: string;
    dryRun: boolean;
    planned: OperationCounts;
    confirmed: OperationCounts;
    reused: number;
    unknownEffects: number;
    code?: ProvisionError["code"];
  };
}
export interface MlflowProvisionService {
  provision(actorId: string, input: ProvisionInput): Promise<ProvisionResult>;
}
export function parseProvisionInput(input: unknown): ProvisionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProvisionError(400, "INPUT");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.organizationSlug !== "string" ||
    !WORKSPACE.test(record.organizationSlug) ||
    typeof record.dryRun !== "boolean"
  )
    throw new ProvisionError(400, "INPUT");
  return { organizationSlug: record.organizationSlug, dryRun: record.dryRun };
}

export function createAcademicSnapshotReader(prisma: PrismaClient) {
  return async (actorId: string, slug: string): Promise<AcademicSnapshot> =>
    prisma.$transaction(
      async (tx) => {
        const administrator = await tx.platformAdministrator.findUnique({
          where: { id: 1 },
          select: { userId: true },
        });
        if (administrator?.userId !== actorId)
          throw new ProvisionError(403, "FORBIDDEN");
        const organization = await tx.organization.findUnique({
          where: { slug },
          select: { id: true, enabled: true },
        });
        if (!organization?.enabled) throw new ProvisionError(404, "NOT_FOUND");
        const memberships = await tx.organizationMembership.findMany({
          where: { organizationId: organization.id },
          take: 101,
          orderBy: { userId: "asc" },
          select: { role: true, user: { select: { id: true, rut: true } } },
        });
        const groups = await tx.group.findMany({
          where: { organizationId: organization.id },
          take: 51,
          orderBy: { id: "asc" },
          select: { id: true },
        });
        const edges = await tx.groupMembership.findMany({
          where: { organizationId: organization.id },
          take: 1001,
          orderBy: [{ groupId: "asc" }, { userId: "asc" }],
          select: { groupId: true, userId: true },
        });
        requireCondition(edges.length <= 1000, "LIMIT");
        const snapshot: AcademicSnapshot = {
          slug,
          users: memberships.map(({ role, user }) => ({ ...user, role })),
          groups: groups.map((group) => ({
            id: group.id,
            userIds: edges
              .filter((edge) => edge.groupId === group.id)
              .map((edge) => edge.userId),
          })),
        };
        validateSnapshot(snapshot);
        return snapshot;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5000,
        timeout: 5000,
      },
    );
}

const USERS = "/api/2.0/mlflow/users";
const ROLES = "/api/3.0/mlflow/roles";
const WORKSPACES = "/api/3.0/mlflow/workspaces";
const EXPERIMENTS = "/api/2.0/mlflow/experiments";
const MODELS = "/api/2.0/mlflow/registered-models";
let activeExecution = false;

function fingerprint(source: AcademicSnapshot) {
  return JSON.stringify({
    slug: source.slug,
    users: [...source.users].sort((a, b) => a.id.localeCompare(b.id)),
    groups: source.groups
      .map((g) => ({ id: g.id, userIds: [...g.userIds].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function createMlflowProvisionService(options: {
  client?: MlflowAdminClient;
  snapshot: (actorId: string, slug: string) => Promise<AcademicSnapshot>;
  credentials: (usernames: string[]) => Promise<Map<string, string>>;
  now?: () => number;
}): MlflowProvisionService {
  const rates = new Map<string, number>();
  const now = options.now ?? Date.now;
  return {
    async provision(actorId, input) {
      const result: ProvisionResult = {
        httpStatus: 200,
        body: {
          status: "ok",
          correlationId: randomUUID(),
          dryRun: input.dryRun,
          planned: emptyCounts(),
          confirmed: emptyCounts(),
          reused: 0,
          unknownEffects: 0,
        },
      };
      let locked = false;
      let inFlightMutation = false;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        PROVISION_LIMITS.deadlineMs,
      );
      const signal = controller.signal;
      const pendingOperations = new Set<Promise<unknown>>();
      // Bound even non-cancellable database/file promises; continuations check the
      // same signal before any subsequent provider operation.
      async function bounded<T>(operation: Promise<T>): Promise<T> {
        pendingOperations.add(operation);
        void operation.then(
          () => pendingOperations.delete(operation),
          () => pendingOperations.delete(operation),
        );
        signal.throwIfAborted();
        let abort: (() => void) | undefined;
        try {
          return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              abort = () => reject(new ProvisionError(503, "DEADLINE"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
        } finally {
          if (abort) signal.removeEventListener("abort", abort);
        }
      }
      let credentials = new Map<string, string>();
      try {
        if (activeExecution) throw new ProvisionError(409, "BUSY");
        const timestamp = now();
        for (const [slug, expires] of rates)
          if (expires <= timestamp) rates.delete(slug);
        if (rates.has(input.organizationSlug) || rates.size >= 1000)
          throw new ProvisionError(429, "RATE");
        activeExecution = true;
        locked = true;
        rates.set(input.organizationSlug, timestamp + 60_000);
        const source = await bounded(
          options.snapshot(actorId, input.organizationSlug),
        );
        requireCondition(source.slug === input.organizationSlug, "INPUT");
        validateSnapshot(source);
        if (!options.client) throw new ProvisionError(503, "DISABLED");
        let calls = 0;
        const call = async (request: AdminRequest) => {
          signal.throwIfAborted();
          if (++calls > PROVISION_LIMITS.calls)
            throw new ProvisionError(400, "LIMIT");
          const data = await bounded(options.client!.request(request, signal));
          signal.throwIfAborted();
          return data;
        };
        const read = async (request: AdminRequest) =>
          providerRecord(await call(request));
        const inventory: ProvisionInventory = {
          workspace: false,
          users: [],
          roles: [],
          experiments: [],
          models: [],
        };
        const userData = await read({ path: `${USERS}/list` });
        inventory.users = providerList(userData, "users", 100).map((value) => {
          const u = providerRecord(value);
          requireCondition(typeof u.is_admin === "boolean");
          return {
            id: providerId(u.id),
            username: providerText(u.username),
            isAdmin: u.is_admin,
          };
        });
        const workspaceData = await call({
          path: `${WORKSPACES}/${encodeURIComponent(source.slug)}`,
          missing: true,
        });
        if (workspaceData) {
          requireCondition(
            providerRecord(workspaceData.workspace).name === source.slug,
          );
          inventory.workspace = true;
          const roleData = await read({
            path: `${ROLES}/list`,
            query: { workspace: source.slug },
            workspace: source.slug,
          });
          let assignments = 0;
          let permissions = 0;
          for (const value of providerList(roleData, "roles", 152)) {
            const r = providerRecord(value);
            const role = {
              id: providerId(r.id),
              name: providerText(r.name),
              workspace: providerText(r.workspace),
              permissions:
                [] as ProvisionInventory["roles"][number]["permissions"],
              members: [] as string[],
            };
            requireCondition(role.workspace === source.slug);
            if (managedRole(role.name)) {
              role.permissions = providerList(r, "permissions", 1000).map(
                (value) => {
                  const p = providerRecord(value);
                  requireCondition(p.role_id === role.id);
                  return {
                    id: providerId(p.id),
                    resourceType: providerText(p.resource_type),
                    pattern: providerText(p.resource_pattern),
                    permission: providerText(p.permission),
                  };
                },
              );
              permissions += role.permissions.length;
              requireCondition(permissions <= 1000, "LIMIT");
              const members = await read({
                path: `${ROLES}/users/list`,
                query: { role_id: String(role.id) },
                workspace: source.slug,
              });
              role.members = providerList(members, "assignments", 1000).map(
                (value) => {
                  const a = providerRecord(value);
                  providerId(a.id);
                  requireCondition(a.role_id === role.id);
                  const user = inventory.users.find(
                    (u) => u.id === providerId(a.user_id),
                  );
                  requireCondition(user);
                  return user.username;
                },
              );
              requireCondition(
                new Set(role.members).size === role.members.length,
              );
              assignments += role.members.length;
              requireCondition(assignments <= 1000, "LIMIT");
            }
            inventory.roles.push(role);
          }
          const names = [
            ...source.users.map((u) => ({
              experiment: `student/${u.rut}/invoice-risk`,
              model: `student-${u.rut}-invoice-review`,
            })),
            ...source.groups.map((g) => ({
              experiment: `group/${g.id}/invoice-risk`,
              model: `group-${g.id}-invoice-review`,
            })),
          ];
          for (const namesForOwner of names) {
            const experiment = await call({
              path: `${EXPERIMENTS}/get-by-name`,
              query: { experiment_name: namesForOwner.experiment },
              workspace: source.slug,
              missing: true,
            });
            if (experiment) {
              const e = providerRecord(experiment.experiment);
              requireCondition(
                e.name === namesForOwner.experiment &&
                  e.lifecycle_stage === "active" &&
                  (e.workspace === undefined || e.workspace === source.slug),
              );
              inventory.experiments.push({
                name: namesForOwner.experiment,
                id: providerText(e.experiment_id),
              });
            }
            const model = await call({
              path: `${MODELS}/get`,
              query: { name: namesForOwner.model },
              workspace: source.slug,
              missing: true,
            });
            if (model) {
              const registered = providerRecord(model.registered_model);
              requireCondition(
                registered.name === namesForOwner.model &&
                  (registered.workspace === undefined ||
                    registered.workspace === source.slug),
              );
              if (registered.tags !== undefined)
                requireCondition(
                  providerList(registered, "tags", 1000).every((tag) => {
                    const t = providerRecord(tag);
                    return (
                      t.key !== "mlflow.prompt.is_prompt" || t.value !== "true"
                    );
                  }),
                );
              inventory.models.push(namesForOwner.model);
            }
          }
        }
        const permissionIds = inventory.roles.flatMap((r) =>
          r.permissions.map((p) => p.id),
        );
        requireCondition(new Set(permissionIds).size === permissionIds.length);
        const plan = buildProvisionPlan(source, inventory);
        result.body.planned = plan.counts;
        result.body.reused = plan.reused;
        requireCondition(
          calls + plan.operations.length <= PROVISION_LIMITS.calls,
          "LIMIT",
        );
        if (input.dryRun) return result;
        const newUsers = plan.operations
          .filter((op) => op.kind === "user")
          .map((op) => op.username);
        if (newUsers.length)
          credentials = await bounded(options.credentials(newUsers));
        if (
          !newUsers.every((username) => {
            const value = credentials.get(username);
            return (
              typeof value === "string" &&
              value.length >= 12 &&
              value.length <= 256
            );
          }) ||
          new Set(credentials.values()).size !== credentials.size
        )
          throw new ProvisionError(503, "CREDENTIALS");
        const checkSource = async () => {
          const refreshed = await bounded(
            options.snapshot(actorId, source.slug),
          );
          signal.throwIfAborted();
          if (fingerprint(refreshed) !== fingerprint(source))
            throw new ProvisionError(503, "SOURCE_CHANGED");
        };
        await checkSource();
        const roleIds = new Map(inventory.roles.map((r) => [r.name, r.id]));
        const userIds = new Map(inventory.users.map((u) => [u.username, u.id]));
        const experimentIds = new Map(
          inventory.experiments.map((e) => [e.name, e.id]),
        );
        for (const operation of plan.operations) {
          signal.throwIfAborted();
          if (
            operation.kind === "revoke" ||
            operation.kind === "unassign" ||
            operation.kind === "grant" ||
            operation.kind === "assign"
          )
            await checkSource();
          const roleId =
            "role" in operation ? roleIds.get(operation.role) : undefined;
          const request: AdminRequest = mutationRequest(
            operation,
            source.slug,
            roleId,
            experimentIds,
            credentials,
          );
          inFlightMutation = true;
          const response = providerRecord(await call(request));
          if (operation.kind === "workspace")
            requireCondition(
              providerRecord(response.workspace).name === source.slug,
            );
          if (operation.kind === "user") {
            const user = providerRecord(response.user);
            requireCondition(
              user.username === operation.username && user.is_admin === false,
            );
            userIds.set(operation.username, providerId(user.id));
            credentials.delete(operation.username);
          }
          if (operation.kind === "experiment") {
            const id = providerText(response.experiment_id);
            requireCondition(EXPERIMENT_ID.test(id));
            experimentIds.set(operation.name, id);
          }
          if (operation.kind === "model")
            requireCondition(
              providerRecord(response.registered_model).name === operation.name,
            );
          if (operation.kind === "role") {
            const role = providerRecord(response.role);
            requireCondition(
              role.workspace === source.slug &&
                role.name === operation.name &&
                providerList(role, "permissions", 0).length === 0,
            );
            roleIds.set(operation.name, providerId(role.id));
          }
          if (operation.kind === "grant") {
            const p = providerRecord(response.role_permission);
            providerId(p.id);
            const expected = request.body as Record<string, unknown>;
            requireCondition(
              p.role_id === expected.role_id &&
                p.resource_type === expected.resource_type &&
                p.resource_pattern === expected.resource_pattern &&
                p.permission === expected.permission,
            );
          }
          if (operation.kind === "assign") {
            const a = providerRecord(response.assignment);
            providerId(a.id);
            requireCondition(
              a.role_id === roleId &&
                a.user_id === userIds.get(operation.username),
            );
          }
          inFlightMutation = false;
          result.body.confirmed[operation.kind]++;
        }
        return result;
      } catch (error) {
        const safe = signal.aborted
          ? new ProvisionError(503, "DEADLINE")
          : error instanceof ProvisionError
            ? error
            : new ProvisionError(502, "DEPENDENCY");
        const partial =
          inFlightMutation ||
          Object.values(result.body.confirmed).some((count) => count > 0);
        result.httpStatus = partial && safe.status < 500 ? 503 : safe.status;
        result.body.code = safe.code;
        result.body.unknownEffects = inFlightMutation ? 1 : 0;
        result.body.status = partial ? "partial" : "error";
        return result;
      } finally {
        clearTimeout(timer);
        controller.abort();
        credentials.clear();
        if (locked) {
          // A timed-out non-cancellable local operation must drain before another
          // execution starts. A permanently stuck operation stays fail-closed.
          if (pendingOperations.size)
            void Promise.allSettled([...pendingOperations]).then(() => {
              activeExecution = false;
            });
          else activeExecution = false;
        }
      }
    },
  };
}

function mutationRequest(
  operation: ProvisionOperation,
  workspace: string,
  roleId: number | undefined,
  experimentIds: Map<string, string>,
  credentials: Map<string, string>,
): AdminRequest {
  const base = { method: "POST" as const, workspace };
  switch (operation.kind) {
    case "workspace":
      return { method: "POST", path: WORKSPACES, body: { name: workspace } };
    case "user":
      return {
        method: "POST",
        path: `${USERS}/create`,
        body: {
          username: operation.username,
          password: credentials.get(operation.username),
        },
      };
    case "experiment":
      return {
        ...base,
        path: `${EXPERIMENTS}/create`,
        body: {
          name: operation.name,
          tags: Object.entries(operation.tags).map(([key, value]) => ({
            key,
            value,
          })),
        },
      };
    case "model":
      return {
        ...base,
        path: `${MODELS}/create`,
        body: {
          name: operation.name,
          tags: Object.entries(operation.tags).map(([key, value]) => ({
            key,
            value,
          })),
        },
      };
    case "role":
      return {
        ...base,
        path: `${ROLES}/create`,
        body: { workspace, name: operation.name },
      };
    case "revoke":
      return {
        method: "DELETE",
        workspace,
        path: `${ROLES}/permissions/remove`,
        body: { role_permission_id: operation.id },
      };
    case "grant": {
      requireCondition(roleId);
      const pattern =
        operation.resourceType === "experiment"
          ? experimentIds.get(operation.pattern)
          : operation.pattern;
      requireCondition(pattern);
      return {
        ...base,
        path: `${ROLES}/permissions/add`,
        body: {
          role_id: roleId,
          resource_type: operation.resourceType,
          resource_pattern: pattern,
          permission: operation.permission,
        },
      };
    }
    case "assign":
    case "unassign":
      requireCondition(roleId);
      return {
        method: operation.kind === "assign" ? "POST" : "DELETE",
        workspace,
        path: `${ROLES}/${operation.kind}`,
        body: { role_id: roleId, username: operation.username },
      };
  }
}
