import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve("../..", file), "utf8");
const readme = read("README.md");
const deploy = read("DEPLOY.md");

const DELETE_SQL = `DELETE FROM "ApiToken" WHERE "scopes" && ARRAY['mlflow:read', 'mlflow:write']::"ApiTokenScope"[];`;

describe("rollback documentation past 20261101 (CR-521)", () => {
  it("DEPLOY.md and the README document the pre-rollback token deletion with the same SQL", () => {
    expect(deploy).toContain(DELETE_SQL);
    expect(readme).toContain(DELETE_SQL);
  });

  it("both say the previous release fails with P2023 and warn the users", () => {
    for (const document of [deploy, readme]) {
      expect(document).toContain("P2023");
      expect(document).toContain("rol dueño");
      expect(document).toMatch(/volver a emitirlos/);
    }
  });

  it("no document still claims that rolling back is safe without the token step", () => {
    expect(readme).not.toMatch(
      /Revertir la aplicación a la versión anterior es seguro:/,
    );
    expect(deploy).toContain("20261101000000_api_token_mlflow_scopes");
  });

  it("the applied migration keeps its (incorrect) comment: the correction lives in the docs", () => {
    const migration = readFileSync(
      resolve(
        "prisma/migrations/20261101000000_api_token_mlflow_scopes/migration.sql",
      ),
      "utf8",
    );
    expect(migration).toContain("Rolling the");
    expect(readme).toContain("checksum");
  });
});
