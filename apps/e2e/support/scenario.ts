import { randomInt } from "node:crypto";

import {
  ALL_FLAGS,
  E2E_PASSWORD,
  NO_FLAGS,
  READ_ONLY,
  people,
  rutOf,
  type Person,
} from "../../backend/e2e/fixtures.ts";
import { Api, settlePassword, type Flags } from "./api.ts";
import {
  RUT_FIRST_BODY,
  RUT_MAX_WORKER_INDEX,
  RUT_RUN_BLOCK_SIZE,
  RUT_RUN_SLOTS,
  RUT_WORKER_BLOCK,
} from "./env.ts";

export { ALL_FLAGS, E2E_PASSWORD, NO_FLAGS, READ_ONLY, people };
export type { Flags, Person };

let counter = 0;
/** A short token that never repeats inside one run (names, slugs, ruts). */
export function unique() {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${randomInt(36 ** 2).toString(36)}`;
}

let rutCounter = 0;
/**
 * A valid RUT (computed check digit: 8 digits, no leading zero) that is not
 * one of the seeded fixtures (those are 11-12 million) and never repeats:
 * the body is the run's block (`E2E_RUN_SLOT`, set once by the global setup,
 * so a second run against reused servers does not hit 409), the worker that
 * asks for it (a restarted worker gets a new index) and a counter that only
 * grows inside that worker.
 */
export function freshRut() {
  const slot = Number(process.env.E2E_RUN_SLOT);
  const worker = Number(process.env.TEST_WORKER_INDEX ?? 0);
  if (!Number.isInteger(slot) || slot < 0 || slot >= RUT_RUN_SLOTS)
    throw new Error("E2E_RUN_SLOT is missing: freshRut needs the global setup");
  if (worker >= RUT_MAX_WORKER_INDEX)
    throw new Error("freshRut: too many restarted workers in one run");
  rutCounter += 1;
  if (rutCounter >= RUT_WORKER_BLOCK)
    throw new Error("freshRut counter exhausted");
  return rutOf(
    String(
      RUT_FIRST_BODY +
        slot * RUT_RUN_BLOCK_SIZE +
        worker * RUT_WORKER_BLOCK +
        rutCounter,
    ),
  );
}

export interface Credentials {
  rut: string;
  password: string;
}

export const asPlatform = (): Promise<Api> =>
  Api.signIn({ rut: people.platform.rut.api, password: E2E_PASSWORD });

export interface ScenarioPerson extends Person {
  id: string;
  credentials: Credentials;
}

export interface Scenario {
  org: { id: string; name: string; slug: string };
  admin: ScenarioPerson;
  members: ScenarioPerson[];
  groups: Array<{ id: string; name: string }>;
  api: Api;
  dispose: () => Promise<void>;
}

/**
 * A private organization with its own ADMIN, members and groups, built through
 * the real API as the platform administrator. Tests that change data use one
 * so they never depend on (or disturb) each other or the seeded fixtures.
 */
export async function createScenario({
  members = 3,
  groups = 0,
  memberFlags = NO_FLAGS,
}: {
  members?: number;
  groups?: number;
  memberFlags?: Flags;
} = {}): Promise<Scenario> {
  const token = unique();
  const api = await asPlatform();

  async function createPerson(
    label: string,
    memberships: unknown[],
  ): Promise<ScenarioPerson> {
    const rut = freshRut();
    const name = `${label} ${token}`;
    const temporaryPassword = `Tmp-${token}-pass`;
    const { user } = await api.call<{ user: { id: string } }>(
      "post",
      "/admin/users",
      { name, rut: rut.api, memberships, temporaryPassword },
    );
    await settlePassword({ rut: rut.api, temporaryPassword });
    return {
      key: label,
      name,
      rut,
      id: user.id,
      credentials: { rut: rut.api, password: E2E_PASSWORD },
    };
  }

  // The first ADMIN must exist before the organization does.
  const admin = await createPerson("Admin", []);
  const { organization } = await api.call<{
    organization: { id: string; name: string; slug: string };
  }>("post", "/organizations", {
    name: `Org ${token}`,
    slug: `org-${token}`,
    firstAdminRut: admin.rut.api,
  });

  const created: ScenarioPerson[] = [];
  for (let index = 0; index < members; index += 1) {
    created.push(
      await createPerson(`Persona${index + 1}`, [
        {
          organizationId: organization.id,
          role: "USER",
          permissions: memberFlags,
          groups: [],
        },
      ]),
    );
  }

  const createdGroups: Array<{ id: string; name: string }> = [];
  for (let index = 0; index < groups; index += 1) {
    const { group } = await api.call<{ group: { id: string; name: string } }>(
      "post",
      `/organizations/${organization.id}/groups`,
      {
        name: `Grupo${index + 1} ${token}`,
        description: `Grupo de prueba ${index + 1}`,
      },
    );
    createdGroups.push(group);
  }

  return {
    org: organization,
    admin,
    members: created,
    groups: createdGroups,
    api,
    dispose: () => api.dispose(),
  };
}
