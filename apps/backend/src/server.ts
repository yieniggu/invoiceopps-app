import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import { createDatabase } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}

const port = Number(process.env.PORT ?? 3000);
const database = createDatabase(databaseUrl);
const app = createApp(database, createAuthService(database.prisma));

app.listen(port, () => {
  console.info(`InvoiceOps backend listening on port ${port}`);
});
