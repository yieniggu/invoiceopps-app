import "dotenv/config";
import { defineConfig } from "prisma/config";

// SHADOW_DATABASE_URL is read only when set (the db:drift check); every other
// command keeps the plain datasource.
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
    ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}),
  },
});
