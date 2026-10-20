import { describe, expect, it } from "vitest";

import {
  buildProvisionPlan,
  type AcademicSnapshot,
  type ProvisionInventory,
} from "../src/mlflow-provision-plan.js";

export const studentId = "11111111-1111-4111-8111-111111111111";
export const groupId = "22222222-2222-4222-8222-222222222222";
export const snapshot: AcademicSnapshot = {
  slug: "data-academy",
  users: [{ id: studentId, rut: "123456785", role: "STUDENT" }],
  groups: [{ id: groupId, userIds: [studentId] }],
};
export function emptyInventory(): ProvisionInventory {
  return {
    workspace: false,
    users: [],
    roles: [],
    experiments: [],
    models: [],
  };
}

describe("MLFLOW07 pure complete reconciliation plan", () => {
  // Installed WorkspaceNameValidator, abstract_store.py:146-180.
  it.each(["workspaces", "api", "ajax-api", "static-files"])(
    "rejects provider-reserved workspace %s before planning",
    (slug) => {
      expect(() =>
        buildProvisionPlan({ ...snapshot, slug }, emptyInventory()),
      ).toThrow("INPUT");
    },
  );

  it("does not reserve valid workspace names merely sharing a reserved prefix", () => {
    for (const slug of [
      "api-course",
      "workspaces-2027",
      "static-files-course",
      "ajax-api-class",
    ]) {
      expect(
        buildProvisionPlan({ ...snapshot, slug }, emptyInventory()).operations,
      ).toContainEqual({ kind: "workspace" });
    }
  });

  it("plans exact canonical resources and scoped roles without creator impersonation", () => {
    const plan = buildProvisionPlan(snapshot, emptyInventory());
    expect(plan.operations).toContainEqual({ kind: "workspace" });
    expect(plan.operations).toContainEqual({
      kind: "user",
      username: "123456785",
    });
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "experiment",
        name: "student/123456785/invoice-risk",
      }),
    );
    expect(plan.operations).toContainEqual(
      expect.objectContaining({
        kind: "model",
        name: `group-${groupId}-invoice-review`,
      }),
    );
    expect(plan.operations).toContainEqual({
      kind: "role",
      name: `group-${groupId}`,
    });
    expect(
      plan.operations.filter((op) => op.kind === "grant"),
    ).not.toContainEqual(
      expect.objectContaining({ permission: "EDIT", pattern: "*" }),
    );
    expect(JSON.stringify(plan)).not.toContain("created_by_rut");
    expect(JSON.stringify(plan)).not.toContain("password");
  });

  it("revokes stale group assignments and incompatible grants but preserves independent roles", () => {
    const inventory = emptyInventory();
    inventory.workspace = true;
    inventory.users = [{ id: 1, username: "123456785", isAdmin: false }];
    inventory.roles = [
      {
        id: 10,
        workspace: snapshot.slug,
        name: `group-${groupId}`,
        permissions: [
          {
            id: 20,
            resourceType: "experiment",
            pattern: "*",
            permission: "MANAGE",
          },
        ],
        members: ["123456785"],
      },
      {
        id: 11,
        workspace: snapshot.slug,
        name: "manual-independent",
        permissions: [],
        members: ["123456785"],
      },
    ];
    const plan = buildProvisionPlan({ ...snapshot, groups: [] }, inventory);
    expect(plan.operations).toContainEqual({ kind: "revoke", id: 20 });
    expect(plan.operations).toContainEqual({
      kind: "unassign",
      role: `group-${groupId}`,
      username: "123456785",
    });
    expect(JSON.stringify(plan.operations)).not.toContain("manual-independent");
    expect(
      plan.operations.some(
        (op) => op.kind === "experiment" && op.name.startsWith("group/"),
      ),
    ).toBe(false);
  });

  it("rejects foreign workspace roles, duplicate identities and complete oversized snapshots", () => {
    const inventory = emptyInventory();
    inventory.roles.push({
      id: 1,
      workspace: "other-tenant",
      name: `group-${groupId}`,
      permissions: [],
      members: [],
    });
    expect(() => buildProvisionPlan(snapshot, inventory)).toThrow();
    expect(() =>
      buildProvisionPlan(
        { ...snapshot, users: [...snapshot.users, ...snapshot.users] },
        emptyInventory(),
      ),
    ).toThrow();
    expect(() =>
      buildProvisionPlan(
        {
          ...snapshot,
          groups: Array.from({ length: 51 }, () => snapshot.groups[0]!),
        },
        emptyInventory(),
      ),
    ).toThrow();
  });

  it("never turns an invalid provider experiment identifier into wildcard EDIT", () => {
    const inventory = emptyInventory();
    inventory.workspace = true;
    inventory.experiments = [
      { name: "student/123456785/invoice-risk", id: "*" },
    ];
    expect(() => buildProvisionPlan(snapshot, inventory)).toThrow();
  });

  it("rejects complete desired role assignment sets above the bound, including base and owner roles", () => {
    const users = Array.from({ length: 100 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      rut: `${String(10000000 + i)}0`,
      role: "STUDENT" as const,
    }));
    const groups = Array.from({ length: 9 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-2222-4222-8222-222222222222`,
      userIds: users.map((u) => u.id),
    }));
    expect(() =>
      buildProvisionPlan({ ...snapshot, users, groups }, emptyInventory()),
    ).toThrow("LIMIT");
  });

  it("preserves global-admin assignments without changing their account or unrelated grants", () => {
    const inventory = emptyInventory();
    inventory.workspace = true;
    inventory.users = [{ id: 1, username: "synthetic-admin", isAdmin: true }];
    inventory.roles = [
      {
        id: 1,
        workspace: snapshot.slug,
        name: "invoiceops-managers",
        permissions: [],
        members: ["synthetic-admin"],
      },
    ];
    const plan = buildProvisionPlan(
      { ...snapshot, users: [], groups: [] },
      inventory,
    );
    expect(plan.operations.some((op) => op.kind === "unassign")).toBe(false);
    expect(plan.operations.some((op) => op.kind === "user")).toBe(false);
  });
});
