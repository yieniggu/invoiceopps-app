import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export interface DatabaseReadiness {
  isReady(): Promise<boolean>;
}

export interface Database extends DatabaseReadiness {
  prisma: PrismaClient;
  /** Releases the connection pool; call once after the server stopped. */
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): Database {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    async close() {
      await prisma.$disconnect();
    },
    async isReady() {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createDatabaseReadiness(
  databaseUrl: string,
): DatabaseReadiness {
  return createDatabase(databaseUrl);
}
