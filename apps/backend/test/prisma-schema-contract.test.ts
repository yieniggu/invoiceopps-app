import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);

function modelBlock(schema: string, modelName: string) {
  const match = schema.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"),
  );

  expect(match, `Prisma schema must declare ${modelName}`).not.toBeNull();

  return match![1];
}

describe("APP-01 Prisma schema contract", () => {
  it("declares globally unique normalized user RUTs", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const user = modelBlock(schema, "User");

    expect(user).toMatch(/^\s*name\s+String\b/m);
    expect(user).toMatch(/^\s*rut\s+String\s+@unique\b/m);
    expect(user).toMatch(/^\s*email\s+String\?(?:\s|$)/m);
    expect(user).toMatch(/^\s*username\s+String\?(?:\s|$)/m);
    expect(user).toMatch(/^\s*passwordHash\s+String\?(?:\s|$)/m);
    expect(user).toMatch(
      /^\s*memberships\s+OrganizationMembership\[\](?:\s|$)/m,
    );
  });

  it("declares the allowlist and hashed server-side sessions", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const allowlist = modelBlock(schema, "AuthorizedUserOrganization");
    const session = modelBlock(schema, "Session");

    expect(allowlist).toMatch(/^\s*rut\s+String\b/m);
    expect(allowlist).toMatch(/^\s*organizationId\s+String\b/m);
    expect(allowlist).toMatch(/@@unique\(\[rut,\s*organizationId\]\)/);
    expect(session).toMatch(/^\s*tokenHash\s+String\s+@unique\b/m);
    expect(session).toMatch(/^\s*expiresAt\s+DateTime\b/m);
  });

  it("declares organizations with their required defaults and uniqueness", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const organization = modelBlock(schema, "Organization");

    expect(organization).toMatch(/^\s*name\s+String\b/m);
    expect(organization).toMatch(/^\s*slug\s+String\s+@unique\b/m);
    expect(organization).toMatch(/^\s*description\s+String\?(?:\s|$)/m);
    expect(organization).toMatch(
      /^\s*enabled\s+Boolean\s+@default\(true\)(?:\s|$)/m,
    );
    expect(organization).toMatch(
      /^\s*createdAt\s+DateTime\s+@default\(now\(\)\)(?:\s|$)/m,
    );
    expect(organization).toMatch(/^\s*updatedAt\s+DateTime\s+@updatedAt\b/m);
    expect(organization).toMatch(
      /^\s*memberships\s+OrganizationMembership\[\](?:\s|$)/m,
    );
    expect(organization).toMatch(/^\s*groups\s+Group\[\](?:\s|$)/m);
  });

  it("prevents duplicate memberships for the same user and organization", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const membership = modelBlock(schema, "OrganizationMembership");

    expect(membership).toMatch(/^\s*userId\s+\w+\b/m);
    expect(membership).toMatch(/^\s*organizationId\s+\w+\b/m);
    expect(membership).toMatch(
      /^\s*user\s+User\s+@relation\(\s*fields:\s*\[userId\],\s*references:\s*\[id\][^)]*\)/m,
    );
    expect(membership).toMatch(
      /^\s*organization\s+Organization\s+@relation\(\s*fields:\s*\[organizationId\],\s*references:\s*\[id\][^)]*\)/m,
    );
    expect(membership).toMatch(/^\s*role\s+\w+\b/m);
    expect(membership).toMatch(/@@unique\(\[userId,\s*organizationId\]\)/);
  });

  it("declares organization-scoped groups with unique group memberships", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const user = modelBlock(schema, "User");
    const group = modelBlock(schema, "Group");
    const membership = modelBlock(schema, "GroupMembership");

    expect(user).toMatch(/^\s*groupMemberships\s+GroupMembership\[\](?:\s|$)/m);
    expect(group).toMatch(/^\s*organizationId\s+String\b/m);
    expect(group).toMatch(/^\s*name\s+String\b/m);
    expect(group).toMatch(
      /^\s*organization\s+Organization\s+@relation\(\s*fields:\s*\[organizationId\],\s*references:\s*\[id\][^)]*\)/m,
    );
    expect(group).toMatch(/^\s*memberships\s+GroupMembership\[\](?:\s|$)/m);
    expect(membership).toMatch(/^\s*groupId\s+String\b/m);
    expect(membership).toMatch(/^\s*userId\s+String\b/m);
    expect(membership).toMatch(/@@unique\(\[groupId,\s*userId\]\)/);
  });
});
