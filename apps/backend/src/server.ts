import { createApp } from "./app.js";
import { createDatabaseReadiness } from "./database.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}

const port = Number(process.env.PORT ?? 3000);
const app = createApp(createDatabaseReadiness(databaseUrl));

app.listen(port, () => {
  console.info(`InvoiceOps backend listening on port ${port}`);
});
