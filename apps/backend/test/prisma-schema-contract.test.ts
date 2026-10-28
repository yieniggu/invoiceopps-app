import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const prismaDirectory = fileURLToPath(new URL("../prisma/", import.meta.url));
const schemaPath = `${prismaDirectory}schema.prisma`;
const migrationsPath = `${prismaDirectory}migrations/`;
const baselineMigration = "20261026000000_initial_recovery_p0";

function modelBlock(schema: string, modelName: string) {
  const match = schema.match(
    new RegExp(`model\\s+${modelName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"),
  );
  expect(match, `Prisma schema must declare ${modelName}`).not.toBeNull();
  return match![1];
}

function enumBlock(schema: string, enumName: string) {
  const match = schema.match(
    new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"),
  );
  expect(match, `Prisma schema must declare enum ${enumName}`).not.toBeNull();
  return match![1];
}

async function readMigration() {
  const entries = (await readdir(migrationsPath)).filter((entry) =>
    /^\d{14}_/.test(entry),
  );
  expect(entries.sort()[0]).toBe(baselineMigration);
  return readFile(
    `${migrationsPath}${baselineMigration}/migration.sql`,
    "utf8",
  );
}

const normalize = (value: string) => value.replace(/\s+/g, " ");

describe("consolidated Prisma schema contract", () => {
  it("ships the baseline migration first and keeps the migration lock", async () => {
    const entries = await readdir(migrationsPath);
    expect(entries.filter((entry) => /^\d{14}_/.test(entry)).sort()[0]).toBe(
      baselineMigration,
    );
    expect(entries).toContain("migration_lock.toml");
  });

  it("declares USER instead of STUDENT and drops legacy models", async () => {
    const schema = await readFile(schemaPath, "utf8");
    expect(normalize(enumBlock(schema, "OrganizationRole")).trim()).toBe(
      "ADMIN USER",
    );
    expect(schema).not.toMatch(/STUDENT/);
    for (const legacy of [
      "ResourceReference",
      "DecisionEvent",
      "EvidenceRecord",
      "EvidenceBatch",
      "EvidenceAnchorReservation",
      "AuthorizedUserOrganization",
      "InvoiceStatus",
    ]) {
      expect(schema).not.toContain(legacy);
    }
  });

  it("keeps the four permission flags on the memberships and not on Group", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const group = modelBlock(schema, "Group");
    for (const flag of [
      "readInvoices",
      "createInvoices",
      "deleteOwnInvoices",
      "deleteOthersInvoices",
    ]) {
      expect(group).not.toContain(flag);
      for (const membership of ["OrganizationMembership", "GroupMembership"]) {
        expect(modelBlock(schema, membership)).toMatch(
          new RegExp(`${flag}\\s+Boolean\\s+@default\\(false\\)`),
        );
      }
    }
    expect(group).toContain("@@unique([id, organizationId])");
  });

  it("models the P0 invoice with pesos, civil dates, soft delete and a group-bound composite key", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const invoice = modelBlock(schema, "Invoice");
    expect(invoice).toMatch(/amountPesos\s+Int\b/);
    expect(invoice).toMatch(/issuedOn\s+DateTime\s+@db\.Date/);
    expect(invoice).toMatch(/dueOn\s+DateTime\s+@db\.Date/);
    expect(invoice).toMatch(/businessId\s+String\s+@db\.VarChar\(80\)/);
    expect(invoice).toMatch(/supplierName\s+String\s+@db\.VarChar\(200\)/);
    expect(invoice).toMatch(
      /processingStatus\s+InvoiceProcessingStatus\s+@default\(NOT_REQUESTED\)/,
    );
    expect(invoice).toMatch(/groupId\s+String\?/);
    expect(invoice).toMatch(/scopeKey\s+String\b/);
    expect(invoice).toContain(
      "fields: [groupId, organizationId], references: [id, organizationId]",
    );
    expect(invoice).toContain("@@unique([organizationId, businessId])");
    expect(invoice).toMatch(/deletedAt\s+DateTime\?/);
    expect(invoice).not.toMatch(/Float|Decimal|vendorName|Cents/);
    expect(normalize(enumBlock(schema, "InvoiceBusinessStatus")).trim()).toBe(
      "PENDING APPROVED REJECTED CANCELLED",
    );
    expect(normalize(enumBlock(schema, "Currency")).trim()).toBe("CLP");
  });

  it("keeps identity, membership, session and audit structures", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const user = modelBlock(schema, "User");
    expect(user).toMatch(/rut\s+String\s+@unique/);
    for (const field of [
      "email\\s+String\\?",
      "username\\s+String\\?",
      "passwordHash\\s+String\\?",
      "mustChangePassword\\s+Boolean\\s+@default\\(false\\)",
      "temporaryPasswordExpiresAt\\s+DateTime\\?",
    ]) {
      expect(user).toMatch(new RegExp(field));
    }
    const organization = modelBlock(schema, "Organization");
    expect(organization).toMatch(/slug\s+String\s+@unique/);
    expect(organization).toMatch(/enabled\s+Boolean\s+@default\(true\)/);
    expect(modelBlock(schema, "OrganizationMembership")).toContain(
      "@@unique([userId, organizationId])",
    );
    expect(modelBlock(schema, "OrganizationMembership")).toContain(
      "@@index([organizationId, role])",
    );
    expect(modelBlock(schema, "GroupMembership")).toContain(
      "@@unique([groupId, userId])",
    );
    expect(modelBlock(schema, "Session")).toMatch(
      /tokenHash\s+String\s+@unique/,
    );
    expect(modelBlock(schema, "PlatformAdministrator")).toMatch(
      /userId\s+String\s+@unique/,
    );
    const audit = modelBlock(schema, "PlatformAdministrativeAuditEvent");
    expect(audit).toContain("@@index([organizationId, createdAt, id])");
    expect(audit).toContain("@@index([targetUserId, createdAt, id])");
    expect(schema).toMatch(/enum PlatformAdministrativeAuditEventType/);
  });

  it("binds idempotency records to the invoice scope", async () => {
    const schema = await readFile(schemaPath, "utf8");
    expect(modelBlock(schema, "Invoice")).toContain(
      "@@unique([id, organizationId, scopeKey])",
    );
    expect(modelBlock(schema, "InvoiceIdempotencyRecord")).toContain(
      "fields: [invoiceId, organizationId, scopeKey], references: [id, organizationId, scopeKey]",
    );
  });

  it("prepares idempotency and API token tables", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const record = modelBlock(schema, "InvoiceIdempotencyRecord");
    expect(record).toContain(
      "@@unique([userId, organizationId, scopeKey, operation, key])",
    );
    expect(record).toMatch(/groupId\s+String\?/);
    const token = modelBlock(schema, "ApiToken");
    expect(token).toMatch(/groupId\s+String\?/);
    expect(token).toMatch(/tokenHash\s+String\s+@unique/);
    expect(token).toMatch(/scopes\s+ApiTokenScope\[\]/);
    const scopes = enumBlock(schema, "ApiTokenScope");
    for (const scope of [
      "invoices:read",
      "invoices:create",
      "invoices:delete-own",
      "invoices:delete-others",
    ]) {
      expect(scopes).toContain(`@map("${scope}")`);
    }
  });

  it("hand-adds the database CHECK constraints and singleton/audit guards", async () => {
    const sql = normalize(await readMigration());
    // Whitespace set shared by the length and trimmed checks (tab, CR, LF, FF, VT).
    const trimSet = String.raw`E' \t\r\n\f\x0b'`;
    for (const fragment of [
      'CHECK ("amountPesos" BETWEEN 1 AND 2147483647)',
      'CHECK ("dueOn" >= "issuedOn")',
      `CHECK (char_length(btrim("businessId", ${trimSet})) BETWEEN 1 AND 80)`,
      `CHECK (char_length(btrim("supplierName", ${trimSet})) BETWEEN 1 AND 200)`,
      'CHECK (("deletedAt" IS NULL) = ("deletedByUserId" IS NULL))',
      'CHECK ("expiresAt" > "createdAt")',
      `CHECK ("businessId" = btrim("businessId", ${trimSet}))`,
      `CHECK ("supplierName" = btrim("supplierName", ${trimSet}))`,
      `CHECK ("expiresAt" <= "createdAt" + interval '30 days')`,
      'CHECK (cardinality("scopes") >= 1)',
      'CHECK (api_token_scopes_are_distinct("scopes"))',
      'FOREIGN KEY ("invoiceId", "organizationId", "scopeKey") REFERENCES "Invoice"("id", "organizationId", "scopeKey") ON DELETE RESTRICT',
      `CHECK ("scopeKey" = COALESCE("groupId", 'organization'))`,
      'CHECK ("id" = 1)',
      'CHECK ("manualReviewThreshold" >= 0 AND "manualReviewThreshold" <= 1)',
      "CREATE TRIGGER prevent_platform_administrator_delete",
      "CREATE TRIGGER prevent_platform_administrative_audit_event_mutation",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).toContain("'invoices:delete-others'");
    expect(sql).not.toMatch(/STUDENT|EvidenceRecord|DecisionEvent/);
  });
});
