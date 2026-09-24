import {
  InvoiceStatus,
  ResourceOwnerType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { createAuthService } from "./auth.js";
import { createDatabase } from "./database.js";
import { LOCAL_DEMONSTRATION } from "./invoices.js";

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db"]);
const LOCAL_DATABASE_NAME = "invoiceops";
const DEMONSTRATION_ORGANIZATION = {
  name: "APP-07 Local Demonstration",
  slug: "app-07-local-demonstration",
  description: "LOCAL_DEMONSTRATION data for APP-07 only",
};
const DEMONSTRATION_USER = {
  name: "APP-07 Demonstration User",
  rut: "111111111",
  password: "app-07-local-demonstration",
};
const POLICY_VERSION = "ml-policy-v1";

export function assertLocalDemonstrationEnvironment(
  nodeEnv: string | undefined,
) {
  if (nodeEnv !== "development") {
    throw new Error("LOCAL_DEMONSTRATION requires NODE_ENV=development");
  }
}

export function assertLocalDemonstrationDatabaseUrl(databaseUrl: string) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(
      "LOCAL_DEMONSTRATION requires the local invoiceops database",
    );
  }

  const databaseName = url.pathname.replace(/^\//, "");
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    !LOCAL_DATABASE_HOSTS.has(url.hostname) ||
    databaseName !== LOCAL_DATABASE_NAME
  ) {
    throw new Error(
      "LOCAL_DEMONSTRATION requires the local invoiceops database",
    );
  }
}

export async function seedLocalDemonstration(prisma: PrismaClient) {
  const organization = await prisma.organization.findUnique({
    where: { slug: DEMONSTRATION_ORGANIZATION.slug },
    select: { id: true, name: true, description: true },
  });
  if (
    organization &&
    (organization.name !== DEMONSTRATION_ORGANIZATION.name ||
      organization.description !== DEMONSTRATION_ORGANIZATION.description)
  ) {
    throw new Error(
      "LOCAL_DEMONSTRATION organization already belongs to other data",
    );
  }
  const localOrganization =
    organization ??
    (await prisma.organization.create({ data: DEMONSTRATION_ORGANIZATION }));

  const existingUser = await prisma.user.findUnique({
    where: { rut: DEMONSTRATION_USER.rut },
    select: { id: true, name: true },
  });
  if (existingUser && existingUser.name !== DEMONSTRATION_USER.name) {
    throw new Error("LOCAL_DEMONSTRATION user already belongs to other data");
  }
  const user =
    existingUser ??
    (await createAuthService(prisma, "open").signUp(DEMONSTRATION_USER));

  await prisma.organizationMembership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: localOrganization.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      organizationId: localOrganization.id,
      role: "STUDENT",
    },
  });
  await prisma.businessPolicy.upsert({
    where: {
      organizationId_ownerType_ownerId_version: {
        organizationId: localOrganization.id,
        ownerType: ResourceOwnerType.USER,
        ownerId: user.id,
        version: POLICY_VERSION,
      },
    },
    update: { manualReviewThreshold: 0.8 },
    create: {
      organizationId: localOrganization.id,
      ownerType: ResourceOwnerType.USER,
      ownerId: user.id,
      version: POLICY_VERSION,
      manualReviewThreshold: 0.8,
    },
  });

  const invoices = [
    {
      invoiceId: "DEMO-RULE-AUTO-POLICY-MANUAL",
      vendorName: "Local demonstration rule auto policy manual",
      invoiceAmountCents: 100_000,
      policyProbability: 0.8,
    },
    {
      invoiceId: "DEMO-RULE-MANUAL-POLICY-AUTO",
      vendorName: "Local demonstration rule manual policy auto",
      invoiceAmountCents: 600_000,
      policyProbability: 0.2,
    },
  ];
  const existingInvoices = await prisma.invoice.findMany({
    where: {
      organizationId: localOrganization.id,
      invoiceId: { in: invoices.map(({ invoiceId }) => invoiceId) },
    },
    select: {
      invoiceId: true,
      ownerType: true,
      ownerId: true,
      createdByUserId: true,
      policyProbabilitySource: true,
    },
  });
  if (
    existingInvoices.some(
      (invoice) =>
        invoice.ownerType !== ResourceOwnerType.USER ||
        invoice.ownerId !== user.id ||
        invoice.createdByUserId !== user.id ||
        invoice.policyProbabilitySource !== LOCAL_DEMONSTRATION,
    )
  ) {
    throw new Error(
      "LOCAL_DEMONSTRATION invoice already belongs to other data",
    );
  }

  for (const invoice of invoices) {
    const data = {
      organizationId: localOrganization.id,
      ownerType: ResourceOwnerType.USER,
      ownerId: user.id,
      createdByUserId: user.id,
      vendorName: invoice.vendorName,
      invoiceAmountCents: invoice.invoiceAmountCents,
      hasPurchaseOrder: true,
      threeWayMatch: true,
      status: InvoiceStatus.PENDING,
      vendorTenureDays: 365,
      previousIncidents12m: 0,
      bankAccountRecentlyChanged: false,
      amountVsVendorMedian: 1,
      countryRisk: "low",
      policyProbability: invoice.policyProbability,
      policyProbabilitySource: LOCAL_DEMONSTRATION,
    };
    await prisma.invoice.upsert({
      where: {
        organizationId_invoiceId: {
          organizationId: localOrganization.id,
          invoiceId: invoice.invoiceId,
        },
      },
      update: data,
      create: { invoiceId: invoice.invoiceId, ...data },
    });
  }

  return { organizationId: localOrganization.id, userId: user.id };
}

async function main() {
  assertLocalDemonstrationEnvironment(process.env.NODE_ENV);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "LOCAL_DEMONSTRATION requires the local invoiceops database",
    );
  }
  assertLocalDemonstrationDatabaseUrl(databaseUrl);
  const database = createDatabase(databaseUrl);
  try {
    await seedLocalDemonstration(database.prisma);
    console.log("APP-07 local demonstration data is ready.");
  } finally {
    await database.prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith("/local-demonstration.ts")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
