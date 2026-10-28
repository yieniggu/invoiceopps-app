import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { Api } from "./api.ts";
import { RUT_RUN_SLOTS } from "./env.ts";
import {
  E2E_PASSWORD,
  organizations,
  people,
} from "../../backend/e2e/fixtures.ts";

/**
 * With `E2E_REUSE_SERVERS` Playwright accepts whatever answers on the ports.
 * Before any spec runs, prove that what answers is the suite's own stack: the
 * seeded platform administrator signs in with the fixture password and sees
 * both seeded organizations. A development backend (a different database and
 * password) fails this, and nothing is written to it: a refused login is the
 * only request. The ports themselves are already kept away from the
 * development ones (see env.ts).
 */
async function assertSeededStack() {
  const reason =
    "The servers on the E2E ports are not the E2E stack (seeded fixtures are missing). Stop them, or unset E2E_REUSE_SERVERS so the suite starts and seeds its own; `pnpm --filter @invoiceops/backend e2e:server` is the only launcher that seeds.";
  let api: Api;
  try {
    api = await Api.signIn({
      rut: people.platform.rut.api,
      password: E2E_PASSWORD,
    });
  } catch {
    throw new Error(reason);
  }
  try {
    const { organizations: all } = await api.call<{
      organizations: Array<{ slug: string }>;
    }>("get", "/organizations");
    const slugs = new Set(all.map(({ slug }) => slug));
    if (
      !slugs.has(organizations.acme.slug) ||
      !slugs.has(organizations.beta.slug)
    )
      throw new Error(reason);
  } finally {
    await api.dispose();
  }
}

/**
 * Screenshots are overwritten per name, so a spec that is renamed or removed
 * would leave a stale image that looks current. Starting from an empty folder
 * keeps `e2e-artifacts/` equal to what this run produced. (Artifacts of a run
 * can contain the throwaway test credentials of the isolated database; see
 * LOCAL_RUN.md.)
 */
export default async function globalSetup() {
  // One identity per run, read by every worker (they inherit this environment).
  // The slot picks the block of RUTs the run may create (see `freshRut`): it
  // comes from the clock, minute by minute, so two runs one after the other
  // against servers that were reused (a database that is not recreated) never
  // draw from the same block until the slots wrap around (about a day).
  process.env.E2E_RUN_ID = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  process.env.E2E_RUN_SLOT = String(
    Math.floor(Date.now() / 60_000) % RUT_RUN_SLOTS,
  );
  rmSync(resolve(import.meta.dirname, "../e2e-artifacts"), {
    recursive: true,
    force: true,
  });
  await assertSeededStack();
}
