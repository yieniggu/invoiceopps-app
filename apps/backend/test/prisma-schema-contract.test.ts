import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);
const platformAdministratorMigrationPath = fileURLToPath(
  new URL(
    "../prisma/migrations/20260922213000_add_platform_administrator/migration.sql",
    import.meta.url,
  ),
);
const modelInferenceMigrationPath = fileURLToPath(
  new URL(
    "../prisma/migrations/20260927213500_add_model_inference_audit/migration.sql",
    import.meta.url,
  ),
);

function modelBlock(schema: string, modelName: string) {
  const match = schema.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"),
  );

  expect(match, `Prisma schema must declare ${modelName}`).not.toBeNull();

  return match![1];
}

describe("APP-01 Prisma schema contract", () => {
  it("rejects incomplete inference snapshots without accepting SQL UNKNOWN", async () => {
    const migration = await readFile(modelInferenceMigrationPath, "utf8");
    const snapshotCheck = migration.match(
      /ADD CONSTRAINT "DecisionEvent_model_inference_snapshot_check" CHECK \(([\s\S]*?)\);/,
    );
    const sourceCheck = migration.match(
      /ADD CONSTRAINT "DecisionEvent_policyProbability_source_check" CHECK \((.*?)\);/,
    );
    const priorMigration = await readFile(
      fileURLToPath(
        new URL(
          "../prisma/migrations/20260923203000_add_business_policies/migration.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const probabilityCheck = priorMigration.match(
      /ADD CONSTRAINT "DecisionEvent_policyProbability_range_check" CHECK \((.*?)\);/,
    );
    expect(snapshotCheck).not.toBeNull();
    expect(sourceCheck).not.toBeNull();
    expect(probabilityCheck).not.toBeNull();

    // SQLite executes the migration's actual CHECK expressions in memory. These
    // operators share SQL three-valued NULL logic with PostgreSQL; this does not
    // validate PostgreSQL migration execution or production data compatibility.
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`CREATE TABLE "DecisionEvent" (
        "policyProbabilitySource" TEXT,
        "modelId" TEXT,
        "modelVersion" TEXT,
        "modelRunId" TEXT,
        "policyProbability" REAL,
        "recommendation" TEXT,
        CHECK (${probabilityCheck![1]}),
        CHECK (${sourceCheck![1]}),
        CHECK (${snapshotCheck![1]})
      )`);
      const insert = database.prepare(
        `INSERT INTO "DecisionEvent" VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const evaluate =
        database.prepare(`SELECT ${snapshotCheck![1]} AS allowed FROM (
        SELECT ? AS "policyProbabilitySource", ? AS "modelId", ? AS "modelVersion",
               ? AS "modelRunId", ? AS "policyProbability", ? AS "recommendation"
      )`);
      type AuditTuple = [
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string | null,
      ];
      const valid: AuditTuple[] = [
        [null, null, null, null, null, null],
        [null, null, null, null, 0.4, null],
        ["MODEL_API", "model", "v1", "run", 0.4, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, null, null, "MANUAL_REVIEW"],
        ["LOCAL_DEMONSTRATION", null, null, null, 0.4, null],
        ["LOCAL_DEMONSTRATION", null, null, null, null, null],
      ];
      const invalid: AuditTuple[] = [
        [null, "model", null, null, null, null],
        [null, null, "v1", null, null, null],
        [null, null, null, "run", null, null],
        [null, "model", "v1", "run", 0.4, "MANUAL_REVIEW"],
        [null, null, null, null, null, "MANUAL_REVIEW"],
        ["MODEL_API", "model", null, "run", 0.4, "MANUAL_REVIEW"],
        ["MODEL_API", null, "v1", "run", 0.4, "MANUAL_REVIEW"],
        ["MODEL_API", "model", "v1", null, 0.4, "MANUAL_REVIEW"],
        ["MODEL_API", "model", "v1", "run", null, "MANUAL_REVIEW"],
        ["MODEL_API", "model", "v1", "run", 0.4, null],
        ["MODEL_API_FALLBACK", "model", null, null, null, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, "v1", null, null, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, "run", null, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, null, 0.4, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, null, null, null],
        ["MODEL_API_FALLBACK", null, null, null, null, "AUTO_PROCESS"],
        ["LOCAL_DEMONSTRATION", "model", null, null, 0.4, null],
        ["LOCAL_DEMONSTRATION", null, "v1", null, 0.4, null],
        ["LOCAL_DEMONSTRATION", null, null, "run", 0.4, null],
        ["LOCAL_DEMONSTRATION", null, null, null, 0.4, "MANUAL_REVIEW"],
        ["MODEL_API", "model", "v1", "run", 1.1, "MANUAL_REVIEW"],
        ["UNRECOGNIZED", null, null, null, null, null],
      ];

      for (const row of valid) {
        expect(evaluate.get(...row)).toEqual({ allowed: 1 });
        expect(() => insert.run(...row)).not.toThrow();
      }
      for (const row of invalid) {
        if (row[0] !== "UNRECOGNIZED" && row[4] !== 1.1) {
          expect(evaluate.get(...row)).toEqual({ allowed: 0 });
        }
        expect(() => insert.run(...row)).toThrow();
      }
    } finally {
      database.close();
    }
  });

  it("declares APP-07 owner-scoped business policies and local demonstration probabilities", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const invoice = modelBlock(schema, "Invoice");
    const policy = modelBlock(schema, "BusinessPolicy");
    const decisionEvent = modelBlock(schema, "DecisionEvent");

    expect(invoice).toMatch(/^\s*policyProbability\s+Decimal\?(?:\s|$)/m);
    expect(invoice).toMatch(/^\s*policyProbabilitySource\s+String\?(?:\s|$)/m);
    expect(policy).toMatch(/^\s*organizationId\s+String\b/m);
    expect(policy).toMatch(/^\s*ownerType\s+ResourceOwnerType\b/m);
    expect(policy).toMatch(/^\s*ownerId\s+String\b/m);
    expect(policy).toMatch(/^\s*version\s+String\b/m);
    expect(policy).toMatch(/^\s*manualReviewThreshold\s+Decimal\b/m);
    expect(policy).toMatch(
      /@@unique\(\[organizationId,\s*ownerType,\s*ownerId,\s*version\]\)/,
    );
    expect(decisionEvent).toMatch(/^\s*mode\s+String\b/m);
    expect(decisionEvent).toMatch(/^\s*policyVersion\s+String\?(?:\s|$)/m);
    expect(decisionEvent).toMatch(
      /^\s*manualReviewThreshold\s+Decimal\?(?:\s|$)/m,
    );
    expect(decisionEvent).toMatch(/^\s*policyProbability\s+Decimal\?(?:\s|$)/m);
    expect(decisionEvent).toMatch(
      /^\s*policyProbabilitySource\s+String\?(?:\s|$)/m,
    );
  });

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

  it("declares the fixed platform administrator and immutable audit events", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const migration = await readFile(
      platformAdministratorMigrationPath,
      "utf8",
    );
    const user = modelBlock(schema, "User");
    const administrator = modelBlock(schema, "PlatformAdministrator");
    const auditEvent = modelBlock(schema, "PlatformAdministrativeAuditEvent");

    expect(user).toMatch(
      /^\s*platformAdministrator\s+PlatformAdministrator\?(?:\s|$)/m,
    );
    expect(administrator).toMatch(/^\s*id\s+Int\s+@id\s+@default\(1\)/m);
    expect(administrator).toMatch(/^\s*userId\s+String\s+@unique\b/m);
    expect(administrator).toMatch(/onDelete:\s*Restrict/);
    expect(auditEvent).toMatch(
      /^\s*type\s+PlatformAdministrativeAuditEventType\b/m,
    );
    expect(auditEvent).toMatch(/^\s*actorUserId\s+String\b/m);
    expect(migration).toContain(
      'CONSTRAINT "PlatformAdministrator_singleton_check" CHECK ("id" = 1)',
    );
    expect(migration).toContain('BEFORE DELETE ON "PlatformAdministrator"');
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "PlatformAdministrativeAuditEvent"',
    );
  });
});

describe("APP-10 Evidence persistence schema proposal", () => {
  it("declares a versioned byte-exact record owned by one decision event", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const record = modelBlock(schema, "EvidenceRecord");

    expect(record).toMatch(/^\s*decisionEventId\s+String\b/m);
    expect(record).toMatch(/^\s*canonicalPayload\s+Bytes\s+@db\.ByteA\b/m);
    expect(record).toMatch(/^\s*leafHash\s+Bytes\s+@db\.ByteA\b/m);
    expect(record).toMatch(/^\s*ownerType\s+ResourceOwnerType\b/m);
    expect(record).toMatch(
      /@@unique\(\[decisionEventId,\s*evidenceVersion\]\)/,
    );
    expect(record).toMatch(/onDelete:\s*Restrict/);
  });

  it("declares batch and membership uniqueness with composite owner relations", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const batch = modelBlock(schema, "EvidenceBatch");
    const member = modelBlock(schema, "EvidenceBatchItem");

    expect(batch).toMatch(/^\s*rootHash\s+Bytes\s+@db\.ByteA\b/m);
    expect(batch).toMatch(/^\s*leafCount\s+Int\b/m);
    expect(batch).toMatch(
      /@@unique\(\[organizationId,\s*ownerType,\s*ownerId,\s*policyVersion,\s*rootHash\]\)/,
    );
    expect(member).toMatch(/@@id\(\[batchId,\s*leafIndex\]\)/);
    expect(member).toMatch(/@@unique\(\[batchId,\s*evidenceRecordId\]\)/);
    expect(member).toMatch(
      /fields:\s*\[batchId,\s*organizationId,\s*ownerType,\s*ownerId\]/,
    );
    expect(member).toMatch(
      /fields:\s*\[evidenceRecordId,\s*organizationId,\s*ownerType,\s*ownerId\]/,
    );
  });

  it("adds bounded byte checks and append-only triggers without rewriting past decisions", async () => {
    const migrations = new URL("../prisma/migrations/", import.meta.url);
    const entries = await readdir(migrations, { withFileTypes: true });
    const statements = (
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            readFile(
              new URL(`${entry.name}/migration.sql`, migrations),
              "utf8",
            ),
          ),
      )
    ).join("\n");

    expect(statements.includes('CREATE TABLE "EvidenceRecord"')).toBe(true);
    expect(statements.includes('CREATE TABLE "EvidenceBatch"')).toBe(true);
    expect(statements.includes('CREATE TABLE "EvidenceBatchItem"')).toBe(true);
    expect(statements).toMatch(/octet_length\("canonicalPayload"\).*16384/);
    expect(statements).toMatch(/octet_length\("leafHash"\).*32/);
    for (const table of [
      "EvidenceRecord",
      "EvidenceBatch",
      "EvidenceBatchItem",
    ]) {
      expect(statements).toContain(`BEFORE UPDATE OR DELETE ON "${table}"`);
    }
    expect(statements).toContain('BEFORE UPDATE OR DELETE ON "DecisionEvent"');
    expect(statements).toContain('BEFORE INSERT ON "EvidenceRecord"');
    expect(statements).toContain("FOR NO KEY UPDATE");
    expect(statements).toContain('SET "ruleVersion" = "ruleVersion"');
  });
});
