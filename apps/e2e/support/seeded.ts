import { Api } from "./api.ts";
import {
  E2E_PASSWORD,
  groups as seededGroups,
  organizations,
  people,
  type Person,
} from "../../backend/e2e/fixtures.ts";

export { E2E_PASSWORD, organizations, people, seededGroups };

export const login = (person: Person) => ({
  rut: person.rut.api,
  password: E2E_PASSWORD,
});

export interface SeededIds {
  acme: { id: string };
  beta: { id: string };
  /** The one organization the platform administrator belongs to. */
  gamma: { id: string };
  groups: { accounting: string; purchasing: string; operations: string };
  users: Record<keyof typeof people, string>;
}

let cached: Promise<SeededIds> | undefined;

/** Looks the seeded rows up through the API (once per worker). */
export function seededIds(): Promise<SeededIds> {
  cached ??= (async () => {
    const acmeAdmin = await Api.signIn(login(people.acmeAdmin));
    const betaAdmin = await Api.signIn(login(people.betaAdmin));
    const platform = await Api.signIn(login(people.platform));
    try {
      // The platform administrator lists every organization.
      const { organizations: every } = await platform.call<{
        organizations: Array<{ id: string; slug: string }>;
      }>("get", "/organizations");
      const gamma = every.find(({ slug }) => slug === organizations.gamma.slug);
      if (!gamma) throw new Error("seeded organization gamma is missing");
      const { organizations: mine } = await acmeAdmin.call<{
        organizations: Array<{ id: string; slug: string }>;
      }>("get", "/organizations");
      const acme = mine.find(({ slug }) => slug === organizations.acme.slug);
      const { organizations: betas } = await betaAdmin.call<{
        organizations: Array<{ id: string; slug: string }>;
      }>("get", "/organizations");
      const beta = betas.find(({ slug }) => slug === organizations.beta.slug);
      if (!acme || !beta) throw new Error("seeded organizations are missing");
      const { groups } = await acmeAdmin.call<{
        groups: Array<{ id: string; name: string }>;
      }>("get", `/organizations/${acme.id}/groups`);
      const group = (name: string) => {
        const found = groups.find((entry) => entry.name === name);
        if (!found) throw new Error(`seeded group ${name} is missing`);
        return found.id;
      };
      const { memberships } = await acmeAdmin.call<{
        memberships: Array<{ user: { id: string; rut: string } }>;
      }>("get", `/organizations/${acme.id}/memberships`);
      const betaMemberships = await betaAdmin.call<{
        memberships: Array<{ user: { id: string; rut: string } }>;
      }>("get", `/organizations/${beta.id}/memberships`);
      const byRut = new Map(
        [...memberships, ...betaMemberships.memberships].map(({ user }) => [
          user.rut,
          user.id,
        ]),
      );
      const users = {} as Record<keyof typeof people, string>;
      for (const [key, person] of Object.entries(people)) {
        // Platform administrator and the lone user belong to no organization.
        users[key as keyof typeof people] =
          byRut.get(person.rut.canonical) ?? "";
      }
      return {
        acme,
        beta,
        gamma,
        groups: {
          accounting: group(seededGroups.accounting.name),
          purchasing: group(seededGroups.purchasing.name),
          operations: group(seededGroups.operations.name),
        },
        users,
      };
    } finally {
      await acmeAdmin.dispose();
      await betaAdmin.dispose();
      await platform.dispose();
    }
  })();
  return cached;
}
