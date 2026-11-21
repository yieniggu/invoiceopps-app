// On-demand supplier key backfill (the server also runs it at startup). Needs DATABASE_URL.
// Development: pnpm --filter @invoiceops/backend backfill:supplier-key
// Runtime image (no pnpm, no tsx): node dist/backfill-supplier-key-command.js
import { createDatabase } from "./database.js";
import { backfillSupplierKeys } from "./supplier-key-backfill.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must be configured");
const database = createDatabase(url);
try {
  const updated = await backfillSupplierKeys(database.prisma);
  console.info(`supplier keys backfilled: ${updated}`);
} finally {
  await database.close();
}
