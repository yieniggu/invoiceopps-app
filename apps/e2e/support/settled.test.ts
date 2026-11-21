import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// CR-594: loading is a skeleton, not text. A screenshot taken while one is
// still on screen is a screenshot of a loading page, so `expectSettled` must
// wait for zero skeletons as well as zero «Cargando…» texts. Playwright's
// `expect` needs a real page, so this reads the helper's source.
const source = readFileSync(new URL("./test.ts", import.meta.url), "utf8");
const body = source.slice(
  source.indexOf("export async function expectSettled"),
);
const settled = body.slice(0, body.indexOf("\n}\n"));

test("expectSettled waits for no skeleton and no loading text", () => {
  assert.match(settled, /data-testid="skeleton"/);
  assert.match(settled, /\.toHaveCount\(0\)/);
  assert.match(settled, /\^Cargando/);
});
