import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import * as localDb from "../scripts/local-db.mjs";
import {
  compareFingerprints,
  getTargetRelations,
  isCleanBootstrapCandidate,
  isSessionExpired,
  isVerifiedCleanSourceCatalog,
  nativeProfileProofSource,
  runMigrationsAfterTargetPreflight,
  safeManagedPostgresReadinessDiagnostic,
  safeProcessDiagnostic,
  verifyAuditGuard,
  verifyManagedContainer,
  verifyMigrationRows,
  waitForManagedPostgres,
} from "../scripts/local-db.mjs";

const managedContainer = {
  Id: "a".repeat(64),
  Name: "/invoiceops-app-dev-db-1",
  Config: {
    Labels: {
      "invoiceops.localdb.owner": "invoiceops-app-managed-local-db-v1",
      "invoiceops.localdb.project": "invoiceops-app",
    },
  },
  Mounts: [
    {
      Type: "volume",
      Name: "invoiceops-app-dev_postgres_data",
      Destination: "/var/lib/postgresql/data",
    },
  ],
  HostConfig: {
    PortBindings: {
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5546" }],
    },
  },
};
const canonicalTargetRelationNames = [
  "_prisma_migrations",
  "User",
  "Organization",
  "OrganizationMembership",
  "Group",
  "GroupMembership",
  "AuthorizedUserOrganization",
  "Session",
  "ResourceReference",
  "Invoice",
  "BusinessPolicy",
  "DecisionEvent",
  "PlatformAdministrator",
  "PlatformAdministrativeAuditEvent",
  "EvidenceRecord",
  "EvidenceBatch",
  "EvidenceBatchItem",
  "EvidenceAnchorReservation",
  "EvidenceSignerPreparationSlot",
  "EvidencePreparedAnchorTransaction",
  "EvidenceAnchorObservation",
].sort();
const canonicalTargetRelations = canonicalTargetRelationNames.map((name) => ({
  name,
  kind: "r",
}));

describe("managed local database safeguards", () => {
  it("runs native profile proof inside an async IIFE and keeps failures sanitized", () => {
    const proof = nativeProfileProofSource();
    expect(proof).toMatch(/^void \(async \(\) =>/);
    expect(proof).toContain("createAuthService(db.prisma, 'open').getProfile");
    expect(proof).toContain("await db.prisma.$disconnect()");

    const canary = "never-print-this-token";
    const diagnostic = safeProcessDiagnostic(
      `${JSON.stringify({
        diagnostic: "native-profile-proof-failed",
        status: 401,
        token: canary,
        message: canary,
      })}\n${canary}`,
    );
    expect(diagnostic).toBe("auth-status-401");
    expect(diagnostic).not.toContain(canary);
  });

  it("treats an expired owned session as requiring rotation", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    expect(isSessionExpired(new Date("2026-10-13T11:59:59.000Z"), now)).toBe(
      true,
    );
    expect(isSessionExpired(new Date("2026-10-13T12:00:01.000Z"), now)).toBe(
      false,
    );
  });

  it("serializes session expiry as UTC independently of the host timezone", () => {
    const expiry = new Date("2026-10-13T23:16:20.167Z");
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "const { prepareValue } = require('pg/lib/utils'); const date = new Date('2026-10-13T23:16:20.167Z'); console.log(JSON.stringify({ date: prepareValue(date), iso: prepareValue(date.toISOString()) }));",
      ],
      {
        encoding: "utf8",
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TZ: "America/Santiago",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      date: "2026-10-13T20:16:20.167-03:00",
      iso: "2026-10-13T23:16:20.167Z",
    });
    expect(localDb.sessionExpiryParameter(expiry)).toBe(
      "2026-10-13T23:16:20.167Z",
    );
  });

  it("uses the canonical SQL audit predicate for inventory count and sample", () => {
    const canonicalMigration = readFileSync(
      new URL(
        "../prisma/migrations/20261013000000_correct_model_inference_snapshot_guard/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const match = canonicalMigration.match(
      /ADD CONSTRAINT "DecisionEvent_model_inference_snapshot_check" CHECK \(([\s\S]*?)\);/,
    );
    expect(match).not.toBeNull();
    const canonicalPredicate = match[1];
    const inventorySql = localDb.sourceInventorySql;

    expect(inventorySql).toContain(`NOT (${canonicalPredicate})`);
    expect(inventorySql.split(`NOT (${canonicalPredicate})`).length - 1).toBe(
      2,
    );

    const database = new DatabaseSync(":memory:");
    try {
      const evaluate =
        database.prepare(`SELECT ${canonicalPredicate} AS allowed FROM (
        SELECT ? AS "policyProbabilitySource", ? AS "modelId", ? AS "modelVersion",
               ? AS "modelRunId", ? AS "policyProbability", ? AS "recommendation"
      )`);
      const valid = [
        [null, null, null, null, 0.4, null],
        ["LOCAL_DEMONSTRATION", null, null, null, 0.4, null],
        ["MODEL_API", "model", "v1", "run", 0.4, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, null, null, "MANUAL_REVIEW"],
      ];
      const invalid = [
        [null, "model", null, null, null, null],
        ["LOCAL_DEMONSTRATION", "model", null, null, 0.4, null],
        ["MODEL_API", "model", null, "run", 0.4, "MANUAL_REVIEW"],
        ["MODEL_API_FALLBACK", null, null, null, 0.4, "MANUAL_REVIEW"],
      ];

      for (const row of valid) {
        expect(evaluate.get(...row)).toEqual({ allowed: 1 });
      }
      for (const row of invalid) {
        expect(evaluate.get(...row)).toEqual({ allowed: 0 });
      }
    } finally {
      database.close();
    }
  });

  it("accepts only the exact managed container, volume, and loopback binding", () => {
    expect(verifyManagedContainer([managedContainer])).toMatchObject({
      Id: "a".repeat(64),
    });
    expect(() =>
      verifyManagedContainer([
        {
          ...managedContainer,
          Config: {
            Labels: {
              ...managedContainer.Config.Labels,
              "invoiceops.localdb.owner": "other",
            },
          },
        },
      ]),
    ).toThrow(/refusing use/);
    expect(() =>
      verifyManagedContainer([
        {
          ...managedContainer,
          HostConfig: {
            PortBindings: {
              "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5546" }],
            },
          },
        },
      ]),
    ).toThrow(/refusing use/);
  });

  it("uses the authenticated loopback probe and retries only transient startup failures", async () => {
    let attempts = 0;
    const sleepCalls = [];

    await waitForManagedPostgres("postgresql://managed-target", {
      async probe(databaseUrl) {
        expect(databaseUrl).toBe("postgresql://managed-target");
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("not ready"), { code: "ECONNREFUSED" });
        }
      },
      async sleep(milliseconds) {
        sleepCalls.push(milliseconds);
      },
    });

    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([500]);
  });

  it("retries a recognized uncoded connection lifecycle failure", async () => {
    let attempts = 0;
    const sleepCalls = [];

    await waitForManagedPostgres("postgresql://managed-target", {
      async probe() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Connection terminated unexpectedly");
        }
      },
      async sleep(milliseconds) {
        sleepCalls.push(milliseconds);
      },
      report() {},
    });

    expect(attempts).toBe(2);
    expect(sleepCalls).toEqual([500]);
  });

  it("fails closed for an uncoded terminal readiness failure", async () => {
    let attempts = 0;

    await expect(
      waitForManagedPostgres("postgresql://managed-target", {
        async probe() {
          attempts += 1;
          throw new Error("password=never-print-this-secret");
        },
        async sleep() {
          throw new Error("terminal errors must not be retried");
        },
        report() {},
      }),
    ).rejects.toThrow(
      "managed PostgreSQL readiness probe failed (error-name-error code-absent message-unclassified); no automatic retry was attempted",
    );

    expect(attempts).toBe(1);
  });

  it("emits bounded sanitized managed PostgreSQL readiness diagnostics", () => {
    const canary = "postgresql://user:never-print-this-secret@host/database";
    const diagnostic = safeManagedPostgresReadinessDiagnostic({
      name: canary,
      code: canary,
      message: canary,
    });

    expect(diagnostic).toBe(
      "error-name-unknown code-present-unrecognized message-unclassified",
    );
    expect(diagnostic).not.toContain(canary);
  });

  it("fails closed when an authenticated readiness probe reports a terminal database error", async () => {
    await expect(
      waitForManagedPostgres("postgresql://managed-target", {
        async probe() {
          throw Object.assign(new Error("authentication failed"), {
            code: "28P01",
          });
        },
        async sleep() {
          throw new Error("terminal errors must not be retried");
        },
      }),
    ).rejects.toThrow(
      "managed PostgreSQL readiness probe failed (error-name-error code-present-postgresql message-unclassified); no automatic retry was attempted",
    );
  });

  it("requires the complete successful canonical migration ledger", () => {
    const expected = [
      { name: "20260101000000_initial", checksum: "a".repeat(64) },
    ];
    expect(() =>
      verifyMigrationRows(
        [
          {
            migration_name: expected[0].name,
            checksum: expected[0].checksum,
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
        expected,
      ),
    ).not.toThrow();
    expect(() =>
      verifyMigrationRows(
        [
          {
            migration_name: expected[0].name,
            checksum: expected[0].checksum,
            finished_at: null,
            rolled_back_at: null,
          },
        ],
        expected,
      ),
    ).toThrow(/ledger/);
    expect(() =>
      verifyMigrationRows(
        [
          {
            migration_name: expected[0].name,
            checksum: "b".repeat(64),
            finished_at: new Date(),
            rolled_back_at: null,
          },
        ],
        expected,
      ),
    ).toThrow(/ledger/);
  });

  it("recognizes only a verified-empty source and complete empty target as a clean bootstrap", async () => {
    const emptyLegacyTables = [
      "User",
      "Organization",
      "OrganizationMembership",
      "Group",
      "GroupMembership",
      "AuthorizedUserOrganization",
      "Session",
      "ResourceReference",
      "Invoice",
      "BusinessPolicy",
      "DecisionEvent",
      "PlatformAdministrator",
      "PlatformAdministrativeAuditEvent",
    ].map((table) => ({
      table,
      rows: 0,
      hash: "d41d8cd98f00b204e9800998ecf8427e",
    }));
    const cleanSource = {
      database: "invoiceops",
      role: "invoiceops",
      nonSystemRelationCount: 0,
    };
    const client = {
      async query(sql) {
        if (sql.includes("FROM pg_constraint")) {
          return {
            rowCount: 1,
            rows: [
              {
                convalidated: true,
                definition: "CHECK (COALESCE(...))",
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    expect(isVerifiedCleanSourceCatalog(cleanSource)).toBe(true);
    expect(
      isCleanBootstrapCandidate(
        emptyLegacyTables,
        Array(7).fill(0),
        canonicalTargetRelations,
      ),
    ).toBe(true);
    await expect(verifyAuditGuard(client, false)).resolves.toBeUndefined();
  });

  it("refuses mixed or partial source and target bootstrap candidates", async () => {
    const emptyLegacyTables = [
      "User",
      "Organization",
      "OrganizationMembership",
      "Group",
      "GroupMembership",
      "AuthorizedUserOrganization",
      "Session",
      "ResourceReference",
      "Invoice",
      "BusinessPolicy",
      "DecisionEvent",
      "PlatformAdministrator",
      "PlatformAdministrativeAuditEvent",
    ].map((table) => ({
      table,
      rows: 0,
      hash: "d41d8cd98f00b204e9800998ecf8427e",
    }));
    const client = {
      async query(sql) {
        if (sql.includes("FROM pg_constraint")) {
          return {
            rowCount: 1,
            rows: [
              {
                convalidated: true,
                definition: "CHECK (COALESCE(...))",
              },
            ],
          };
        }
        return { rowCount: 0, rows: [] };
      },
    };
    const partialSource = {
      database: "invoiceops",
      role: "invoiceops",
      nonSystemRelationCount: 1,
    };
    const wrongSourceIdentity = {
      database: "other",
      role: "invoiceops",
      nonSystemRelationCount: 0,
    };
    const partialLegacy = emptyLegacyTables.map((row) =>
      row.table === "User" ? { ...row, rows: 1 } : row,
    );

    expect(isVerifiedCleanSourceCatalog(partialSource)).toBe(false);
    expect(isVerifiedCleanSourceCatalog(wrongSourceIdentity)).toBe(false);
    expect(
      isCleanBootstrapCandidate(
        partialLegacy,
        Array(7).fill(0),
        canonicalTargetRelations,
      ),
    ).toBe(false);
    expect(
      isCleanBootstrapCandidate(
        emptyLegacyTables,
        [1, ...Array(6).fill(0)],
        canonicalTargetRelations,
      ),
    ).toBe(false);
    expect(
      isCleanBootstrapCandidate(
        emptyLegacyTables.slice(1),
        Array(7).fill(0),
        canonicalTargetRelations,
      ),
    ).toBe(false);
    expect(
      isCleanBootstrapCandidate(
        emptyLegacyTables,
        Array(7).fill(0),
        canonicalTargetRelations.slice(1),
      ),
    ).toBe(false);
    expect(
      isCleanBootstrapCandidate(emptyLegacyTables, Array(7).fill(0), [
        ...canonicalTargetRelations,
        { name: "stale_bootstrap_view", kind: "v" },
      ]),
    ).toBe(false);
    await expect(verifyAuditGuard(client, true)).rejects.toThrow(
      /Expected existing decision row/,
    );
  });

  it("rejects a stale public view after cataloging every relevant relation kind", async () => {
    let catalogSql;
    const relations = await getTargetRelations({
      async query(sql) {
        catalogSql = sql;
        return {
          rows: [
            ...canonicalTargetRelations,
            { name: "stale_bootstrap_view", kind: "v" },
          ],
        };
      },
    });

    expect(catalogSql).toContain("IN ('r', 'p', 'v', 'm', 'S', 'f')");
    expect(relations).toContainEqual({
      name: "stale_bootstrap_view",
      kind: "v",
    });
  });

  it("rejects pre-existing non-adoptable targets before invoking canonical migrations", async () => {
    let migrationCalls = 0;
    const existing = { Id: "a".repeat(64) };
    const expected = [
      { name: "20260101000000_initial", checksum: "a".repeat(64) },
    ];
    const matchingMetadata = {
      target: {
        containerId: existing.Id,
        volume: "invoiceops-app-dev_postgres_data",
        port: 5546,
      },
      migrations: expected,
      dataFingerprint: [],
    };
    const cases = [
      {
        name: "extra stale relation",
        metadata: null,
        expected: [],
        client: {
          async query(sql) {
            if (sql.includes("FROM pg_class")) {
              return {
                rows: [
                  ...canonicalTargetRelations,
                  { name: "stale_bootstrap_view", kind: "v" },
                ],
              };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
        },
      },
      {
        name: "unknown canonical target without a manifest",
        metadata: null,
        expected: [],
        client: {
          async query(sql) {
            if (sql.includes("FROM pg_class")) {
              return { rows: canonicalTargetRelations };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
        },
      },
      {
        name: "incompatible migration ledger",
        metadata: matchingMetadata,
        expected,
        client: {
          async query(sql) {
            if (sql.includes("FROM pg_class")) {
              return { rows: canonicalTargetRelations };
            }
            if (sql.includes('FROM "_prisma_migrations"')) {
              return { rows: [] };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
        },
      },
    ];

    for (const candidate of cases) {
      await expect(
        runMigrationsAfterTargetPreflight(candidate.client, {
          existing,
          metadata: candidate.metadata,
          expected: candidate.expected,
          async runMigrations() {
            migrationCalls += 1;
          },
        }),
      ).rejects.toThrow(
        /refusing migration deployment|refusing to adopt|ledger/,
      );
    }

    expect(migrationCalls).toBe(0);
  });

  it("allows canonical migrations only for a genuinely fresh owned target", async () => {
    let migrationCalls = 0;
    const preflight = await runMigrationsAfterTargetPreflight(
      {
        async query(sql) {
          expect(sql).toContain("FROM pg_class");
          return { rows: [] };
        },
      },
      {
        existing: { Id: "a".repeat(64) },
        metadata: null,
        expected: [],
        async runMigrations() {
          migrationCalls += 1;
        },
      },
    );

    expect(preflight).toEqual({ kind: "fresh" });
    expect(migrationCalls).toBe(1);
  });

  it("rejects mismatched source/target aggregate fingerprints", () => {
    const source = [{ table: "User", rows: "1", hash: "a" }];
    expect(() =>
      compareFingerprints(source, [{ table: "User", rows: 1, hash: "a" }]),
    ).not.toThrow();
    expect(() =>
      compareFingerprints(source, [{ table: "User", rows: 1, hash: "b" }]),
    ).toThrow(/fingerprints differ/);
  });
});
