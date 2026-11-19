import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { removeSecretErrorContexts } from "./global-teardown.ts";

const SECRET_FOLDERS = [
  "admin-users-a-chromium",
  "admin-wizard-b-mobile",
  "member-creation-secret-c-desktop",
  "api-tokens-d-desktop",
  "swagger-e-desktop",
  "rpa-invoice-batch-g-RPA-invoice-batch-bot-desktop",
  "rpa-cli-signal-i-RPA-CLI-signals-desktop",
  "rpa-demo-h-RPA-demo-demo",
];

test("removeSecretErrorContexts drops the snapshots of the specs that show a secret and keeps the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-teardown-"));
  try {
    for (const name of [...SECRET_FOLDERS, "groups-f-desktop"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "error-context.md"), "snapshot");
    }
    const removed = removeSecretErrorContexts(dir);
    assert.equal(removed.length, SECRET_FOLDERS.length);
    for (const name of SECRET_FOLDERS) {
      assert.equal(
        existsSync(join(dir, name, "error-context.md")),
        false,
        name,
      );
    }
    assert.equal(
      existsSync(join(dir, "groups-f-desktop", "error-context.md")),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
