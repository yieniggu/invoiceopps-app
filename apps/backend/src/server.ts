import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import { createBusinessPolicyService } from "./business-policies.js";
import { createDatabase } from "./database.js";
import { createGroupService } from "./groups.js";
import { createInvoiceService } from "./invoices.js";
import { createModelApiClient } from "./model-api-client.js";
import { createResourceService } from "./resources.js";
import { createPlatformAdministratorService } from "./platform-administrator.js";

const databaseUrl = process.env.DATABASE_URL;
const modelApiUrl = process.env.MODEL_API_URL;
const modelApiModelId = process.env.MODEL_API_MODEL_ID;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}
const port = Number(process.env.PORT ?? 3000);
const database = createDatabase(databaseUrl);
const app = createApp(database, createAuthService(database.prisma), {
  groups: createGroupService(database.prisma),
  invoices: createInvoiceService(
    database.prisma,
    modelApiUrl && modelApiModelId
      ? createModelApiClient({ baseUrl: modelApiUrl, modelId: modelApiModelId })
      : undefined,
  ),
  businessPolicies: createBusinessPolicyService(database.prisma),
  resources: createResourceService(database.prisma),
  platformAdministrators: createPlatformAdministratorService(database.prisma),
});

app.listen(port, () => {
  console.info(`InvoiceOps backend listening on port ${port}`);
});
