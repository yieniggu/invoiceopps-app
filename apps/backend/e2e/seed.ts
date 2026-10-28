// Seeds the isolated recovery test database for the browser E2E suite. It only
// runs through scripts/e2e-backend.mjs, which has already recreated the
// database; it refuses any other target.

import {
  assertRecoveryTarget,
  testDatabaseName,
} from "../scripts/recovery-db-guards.mjs";
import { createDatabase } from "../src/database.js";
import { hashPassword } from "../src/features/auth/services.js";
import {
  ALL_FLAGS,
  E2E_PASSWORD,
  NO_FLAGS,
  READ_ONLY,
  groups,
  invoices,
  organizations,
  people,
} from "./fixtures.js";

// Same guard as the reset and the PostgreSQL suites: loopback host and the
// exact recovery test database name (a look-alike path never passes).
const target = assertRecoveryTarget(process.env.DATABASE_URL, {
  confirmReset: testDatabaseName,
  allowedNames: [testDatabaseName],
});

const database = createDatabase(target.url);
const { prisma } = database;

async function main() {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  const user = new Map<string, string>();
  for (const person of Object.values(people)) {
    const created = await prisma.user.create({
      data: {
        name: person.name,
        rut: person.rut.canonical,
        passwordHash,
        mustChangePassword: false,
      },
      select: { id: true },
    });
    user.set(person.key, created.id);
  }
  const id = (key: keyof typeof people) => user.get(key) as string;

  await prisma.platformAdministrator.create({
    data: { id: 1, userId: id("platform") },
  });

  const acme = await prisma.organization.create({
    data: { ...organizations.acme, description: "Operación logística" },
  });
  const beta = await prisma.organization.create({
    data: { ...organizations.beta, description: null },
  });
  const gamma = await prisma.organization.create({
    data: {
      ...organizations.gamma,
      description: "Administración de plataforma",
    },
  });

  const member = (
    key: keyof typeof people,
    organizationId: string,
    role: "ADMIN" | "USER",
    flags: typeof NO_FLAGS,
  ) =>
    prisma.organizationMembership.create({
      data: { userId: id(key), organizationId, role, ...flags },
    });

  await member("acmeAdmin", acme.id, "ADMIN", ALL_FLAGS);
  await member("acmeUser", acme.id, "USER", READ_ONLY);
  await member("carla", acme.id, "USER", READ_ONLY);
  await member("diego", acme.id, "USER", NO_FLAGS);
  await member("elena", acme.id, "USER", NO_FLAGS);
  await member("felipe", acme.id, "USER", NO_FLAGS);
  await member("betaAdmin", beta.id, "ADMIN", ALL_FLAGS);
  await member("acmeUser", beta.id, "USER", NO_FLAGS);
  // Administrative authority only: no invoice permission and no group.
  await member("platform", gamma.id, "USER", NO_FLAGS);

  const accounting = await prisma.group.create({
    data: { organizationId: acme.id, ...groups.accounting },
  });
  const purchasing = await prisma.group.create({
    data: { organizationId: acme.id, ...groups.purchasing },
  });
  await prisma.group.create({
    data: { organizationId: acme.id, ...groups.operations },
  });
  await prisma.group.create({
    data: { organizationId: beta.id, name: "Soporte" },
  });

  const inGroup = (
    groupId: string,
    key: keyof typeof people,
    flags: typeof NO_FLAGS,
  ) =>
    prisma.groupMembership.create({
      data: { groupId, userId: id(key), organizationId: acme.id, ...flags },
    });
  await inGroup(accounting.id, "carla", READ_ONLY);
  await inGroup(accounting.id, "diego", ALL_FLAGS);
  await inGroup(purchasing.id, "acmeUser", READ_ONLY);

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  for (const [index, invoice] of invoices.entries()) {
    await prisma.invoice.create({
      data: {
        businessId: invoice.businessId,
        organizationId: acme.id,
        // P0 invoices live in groups; the scope key mirrors the group id.
        groupId: accounting.id,
        scopeKey: accounting.id,
        supplierName: invoice.supplier,
        amountPesos: invoice.amount,
        currency: "CLP",
        issuedOn: day(`2026-09-0${index + 1}`),
        dueOn: day(`2026-10-0${index + 1}`),
        businessStatus: index === 1 ? "APPROVED" : "PENDING",
        createdByUserId: id("acmeAdmin"),
      },
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "seed failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
