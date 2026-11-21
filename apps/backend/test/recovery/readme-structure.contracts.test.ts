import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve("../..", "README.md"), "utf8");
const at = (needle: string) => {
  const index = readme.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

describe("README structure (CR-527, CR-529, CR-530)", () => {
  it("keeps the token issuance limits and Bearer usage inside the API tokens section", () => {
    const tokens = at("### Tokens de API operacionales");
    const limits = at("Límites de emisión:");
    const bearer = at("Un token se usa con `Authorization: Bearer");
    const introspection = at("#### Introspección privada");
    const migrationNotes = at("#### Notas de migración de MLOps");
    expect(tokens).toBeLessThan(limits);
    expect(limits).toBeLessThan(bearer);
    expect(bearer).toBeLessThan(introspection);
    expect(introspection).toBeLessThan(migrationNotes);
  });

  it("points to the 20261101 correction in the right direction", () => {
    expect(readme).not.toContain("corrección de `20261101…` más abajo");
    const reference = at("corrección de `20261101…` más arriba");
    expect(
      at("Corrección sobre `20261101000000_api_token_mlflow_scopes"),
    ).toBeLessThan(reference);
  });

  it("flags the outdated 20261121 comment", () => {
    expect(readme).toContain("Comentario desactualizado en `20261121…`");
    expect(readme).toMatch(/calcula la clave al vuelo/);
  });

  it("scopes the retention index claim to the batch selection subquery", () => {
    expect(readme).toMatch(/selección del lote/);
    expect(readme).toMatch(/`DELETE` externo/);
  });
});
