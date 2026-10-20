export const PROVISION_LIMITS = {
  users: 100,
  groups: 50,
  assignments: 1000,
  calls: 2000,
  deadlineMs: 60_000,
  callMs: 5000,
} as const;
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const EXPERIMENT_ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Match the installed WorkspaceNameValidator, including its exact reserved names.
export const WORKSPACE =
  /^(?!(?:workspaces|api|ajax-api|static-files)$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])$/;
export const RUT = /^[0-9]{7,8}[0-9K]$/;

export class ProvisionError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503,
    readonly code:
      | "INPUT"
      | "LIMIT"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "BUSY"
      | "RATE"
      | "DEPENDENCY"
      | "INVALID_PROVIDER"
      | "CREDENTIALS"
      | "SOURCE_CHANGED"
      | "DISABLED"
      | "DEADLINE",
  ) {
    super(code);
  }
}

export interface AcademicSnapshot {
  slug: string;
  users: Array<{ id: string; rut: string; role: "ADMIN" | "STUDENT" }>;
  groups: Array<{ id: string; userIds: string[] }>;
}
export interface ProviderUser {
  id: number;
  username: string;
  isAdmin: boolean;
}
export interface ProviderPermission {
  id: number;
  resourceType: string;
  pattern: string;
  permission: string;
}
export interface ProviderRole {
  id: number;
  name: string;
  workspace: string;
  permissions: ProviderPermission[];
  members: string[];
}
export interface ProvisionInventory {
  workspace: boolean;
  users: ProviderUser[];
  roles: ProviderRole[];
  experiments: Array<{ name: string; id: string }>;
  models: string[];
}
export type ProvisionOperation =
  | { kind: "workspace" }
  | { kind: "user"; username: string }
  | { kind: "experiment" | "model"; name: string; tags: Record<string, string> }
  | { kind: "role"; name: string }
  | { kind: "revoke"; id: number }
  | {
      kind: "grant";
      role: string;
      resourceType: string;
      pattern: string;
      permission: string;
    }
  | { kind: "assign" | "unassign"; role: string; username: string };
export type OperationCounts = Record<ProvisionOperation["kind"], number>;
export function emptyCounts(): OperationCounts {
  return {
    workspace: 0,
    user: 0,
    experiment: 0,
    model: 0,
    role: 0,
    revoke: 0,
    grant: 0,
    assign: 0,
    unassign: 0,
  };
}
export function requireCondition(
  condition: unknown,
  code: "LIMIT" | "INVALID_PROVIDER" | "INPUT" = "INVALID_PROVIDER",
): asserts condition {
  if (!condition)
    throw new ProvisionError(
      code === "INPUT" || code === "LIMIT" ? 400 : 502,
      code,
    );
}
function unique(values: Array<string | number>) {
  return new Set(values).size === values.length;
}
export function managedRole(name: string) {
  return (
    name === "invoiceops-base" ||
    name === "invoiceops-managers" ||
    (name.startsWith("invoiceops-owner-") && UUID.test(name.slice(17))) ||
    (name.startsWith("group-") && UUID.test(name.slice(6)))
  );
}

export function validateSnapshot(source: AcademicSnapshot) {
  requireCondition(WORKSPACE.test(source.slug), "INPUT");
  requireCondition(
    source.users.length <= PROVISION_LIMITS.users &&
      source.groups.length <= PROVISION_LIMITS.groups &&
      source.groups.reduce((sum, group) => sum + group.userIds.length, 0) <=
        PROVISION_LIMITS.assignments,
    "LIMIT",
  );
  const ids = new Set(source.users.map((user) => user.id));
  requireCondition(
    unique(source.users.map((user) => user.id)) &&
      unique(source.users.map((user) => user.rut)) &&
      unique(source.groups.map((group) => group.id)),
    "INPUT",
  );
  requireCondition(
    source.users.every(
      (user) =>
        UUID.test(user.id) &&
        RUT.test(user.rut) &&
        ["ADMIN", "STUDENT"].includes(user.role),
    ) &&
      source.groups.every(
        (group) =>
          UUID.test(group.id) &&
          unique(group.userIds) &&
          group.userIds.every((id) => ids.has(id)),
      ),
    "INPUT",
  );
}

export function buildProvisionPlan(
  source: AcademicSnapshot,
  inventory: ProvisionInventory,
) {
  validateSnapshot(source);
  requireCondition(
    inventory.users.length <= 100 &&
      inventory.roles.length <= 152 &&
      inventory.experiments.length <= 150 &&
      inventory.models.length <= 150,
    "LIMIT",
  );
  requireCondition(
    unique(inventory.users.map((u) => u.id)) &&
      unique(inventory.users.map((u) => u.username)) &&
      unique(inventory.roles.map((r) => r.id)) &&
      unique(inventory.roles.map((r) => r.name)) &&
      unique(inventory.experiments.map((e) => e.name)) &&
      unique(inventory.experiments.map((e) => e.id)) &&
      unique(inventory.models),
  );
  requireCondition(
    inventory.roles.every((role) => role.workspace === source.slug),
  );
  requireCondition(
    inventory.experiments.every((experiment) =>
      EXPERIMENT_ID.test(experiment.id),
    ),
  );
  requireCondition(
    new Set([
      ...source.groups.map((group) => `group-${group.id}`),
      ...inventory.roles
        .filter(
          (role) => role.name.startsWith("group-") && managedRole(role.name),
        )
        .map((role) => role.name),
    ]).size <= 50,
    "LIMIT",
  );
  requireCondition(
    new Set([
      ...source.users.map((user) => `invoiceops-owner-${user.id}`),
      ...inventory.roles
        .filter(
          (role) =>
            role.name.startsWith("invoiceops-owner-") && managedRole(role.name),
        )
        .map((role) => role.name),
    ]).size <= 100,
    "LIMIT",
  );
  requireCondition(
    inventory.roles.reduce((n, role) => n + role.members.length, 0) <= 1000 &&
      inventory.roles.reduce((n, role) => n + role.permissions.length, 0) <=
        1000,
    "LIMIT",
  );
  const operations: ProvisionOperation[] = [];
  let reused = 0;
  if (!inventory.workspace) operations.push({ kind: "workspace" });
  else reused++;
  for (const user of source.users) {
    if (!inventory.users.some((existing) => existing.username === user.rut))
      operations.push({ kind: "user", username: user.rut });
    else reused++;
  }
  requireCondition(
    inventory.users.length +
      operations.filter((op) => op.kind === "user").length <=
      100,
    "LIMIT",
  );
  type DesiredRole = {
    name: string;
    members: string[];
    grants: Array<{
      resourceType: string;
      pattern: string;
      permission: string;
    }>;
  };
  const roles: DesiredRole[] = [
    {
      name: "invoiceops-base",
      members: source.users.map((u) => u.rut),
      grants: [{ resourceType: "workspace", pattern: "*", permission: "USE" }],
    },
    {
      name: "invoiceops-managers",
      members: source.users.filter((u) => u.role === "ADMIN").map((u) => u.rut),
      grants: [
        { resourceType: "workspace", pattern: "*", permission: "MANAGE" },
      ],
    },
  ];
  const owners = [
    ...source.users.map((user) => ({
      role: `invoiceops-owner-${user.id}`,
      ownerType: "user",
      id: user.id,
      experiment: `student/${user.rut}/invoice-risk`,
      model: `student-${user.rut}-invoice-review`,
      members: [user.rut],
    })),
    ...source.groups.map((group) => ({
      role: `group-${group.id}`,
      ownerType: "group",
      id: group.id,
      experiment: `group/${group.id}/invoice-risk`,
      model: `group-${group.id}-invoice-review`,
      members: group.userIds.map(
        (id) => source.users.find((u) => u.id === id)!.rut,
      ),
    })),
  ];
  for (const owner of owners) {
    const tags = {
      organization_slug: source.slug,
      owner_type: owner.ownerType,
      owner_id: owner.id,
    };
    if (!inventory.experiments.some((e) => e.name === owner.experiment))
      operations.push({ kind: "experiment", name: owner.experiment, tags });
    else reused++;
    if (!inventory.models.includes(owner.model))
      operations.push({ kind: "model", name: owner.model, tags });
    else reused++;
    roles.push({
      name: owner.role,
      members: owner.members,
      grants: [
        {
          resourceType: "experiment",
          pattern: owner.experiment,
          permission: "EDIT",
        },
        {
          resourceType: "registered_model",
          pattern: owner.model,
          permission: "EDIT",
        },
      ],
    });
  }
  const desiredAssignments = roles.reduce(
    (n, role) => n + role.members.length,
    0,
  );
  requireCondition(desiredAssignments <= 1000, "LIMIT");
  for (const role of roles) {
    if (!inventory.roles.some((existing) => existing.name === role.name))
      operations.push({ kind: "role", name: role.name });
    else reused++;
  }
  requireCondition(
    inventory.roles.length +
      operations.filter((op) => op.kind === "role").length <=
      152,
    "LIMIT",
  );
  const admins = new Set(
    inventory.users.filter((u) => u.isAdmin).map((u) => u.username),
  );
  for (const name of new Set([
    ...roles.map((r) => r.name),
    ...inventory.roles.filter((r) => managedRole(r.name)).map((r) => r.name),
  ])) {
    const desired = roles.find((r) => r.name === name);
    const existing = inventory.roles.find((r) => r.name === name);
    const grants = desired?.grants ?? [];
    const actualPattern = (grant: { resourceType: string; pattern: string }) =>
      grant.resourceType === "experiment"
        ? inventory.experiments.find((e) => e.name === grant.pattern)?.id
        : grant.pattern;
    for (const permission of existing?.permissions ?? []) {
      if (
        !grants.some(
          (grant) =>
            permission.resourceType === grant.resourceType &&
            permission.pattern === actualPattern(grant) &&
            permission.permission === grant.permission,
        )
      )
        operations.push({ kind: "revoke", id: permission.id });
    }
    for (const grant of grants) {
      if (
        !existing?.permissions.some(
          (p) =>
            p.resourceType === grant.resourceType &&
            p.pattern === actualPattern(grant) &&
            p.permission === grant.permission,
        )
      )
        operations.push({ kind: "grant", role: name, ...grant });
      else reused++;
    }
    for (const username of existing?.members ?? []) {
      if (!desired?.members.includes(username) && !admins.has(username))
        operations.push({ kind: "unassign", role: name, username });
    }
    for (const username of desired?.members ?? []) {
      if (!existing?.members.includes(username))
        operations.push({ kind: "assign", role: name, username });
      else reused++;
    }
  }
  // Revoke incompatible grants and stale memberships before adding privileges.
  const order: Record<ProvisionOperation["kind"], number> = {
    workspace: 0,
    user: 1,
    experiment: 2,
    model: 2,
    role: 3,
    revoke: 4,
    unassign: 4,
    grant: 5,
    assign: 6,
  };
  operations.sort((a, b) => order[a.kind] - order[b.kind]);
  const counts = emptyCounts();
  for (const op of operations) counts[op.kind]++;
  return { operations, counts, reused };
}
