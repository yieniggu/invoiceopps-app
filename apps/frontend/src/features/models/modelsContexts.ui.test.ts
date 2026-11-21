import { describe, expect, it } from "vitest";

import {
  hasModelsAccess,
  modelsContextOptions,
  selectedModelsContext,
} from "./modelsContexts";
import { NO_PERMISSIONS } from "../permissions/types";
import type { Profile } from "../auth/types";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const DEPLOY = { ...NO_PERMISSIONS, deployModels: true };

const profile = (): Pick<Profile, "memberships"> => ({
  memberships: [
    {
      organization: { id: ORG_A, name: "Acme", slug: "acme", mlEnabled: true },
      role: "USER",
      permissions: DEPLOY,
      groups: [
        {
          group: { id: GROUP, name: "Finanzas" },
          permissions: NO_PERMISSIONS,
          effective: DEPLOY,
        },
      ],
    },
    {
      organization: { id: ORG_B, name: "Beta", slug: "beta", mlEnabled: false },
      role: "ADMIN",
      permissions: DEPLOY,
      groups: [],
    },
  ],
});

describe("models contexts", () => {
  it("offers the organization and its groups, only for organizations that enabled it", () => {
    const options = modelsContextOptions(profile());
    expect(options.map((option) => option.label)).toEqual([
      "Organización · Acme",
      "Grupo Finanzas · Acme",
    ]);
    expect(options.every((option) => option.canDeploy)).toBe(true);
    expect(hasModelsAccess(profile())).toBe(true);
    expect(
      hasModelsAccess({
        memberships: [{ ...profile().memberships[1]! }],
      }),
    ).toBe(false);
  });

  it("derives canDeploy from the flag in each context, not from the role", () => {
    const base = profile();
    base.memberships[0]!.permissions = NO_PERMISSIONS;
    base.memberships[0]!.groups[0]!.effective = NO_PERMISSIONS;
    expect(modelsContextOptions(base).map((o) => o.canDeploy)).toEqual([
      false,
      false,
    ]);
  });

  it("selects from the URL, falling back to the first option on anything odd", () => {
    const options = modelsContextOptions(profile());
    const pick = (query: string) =>
      selectedModelsContext(options, new URLSearchParams(query))?.value;
    expect(pick(`organizationId=${ORG_A}&groupId=${GROUP}`)).toBe(
      `group:${ORG_A}:${GROUP}`,
    );
    expect(pick(`organizationId=${ORG_A}`)).toBe(`org:${ORG_A}`);
    // Another organization, a malformed id or nothing: the default.
    expect(pick(`organizationId=${ORG_B}`)).toBe(`org:${ORG_A}`);
    expect(pick("organizationId=not-a-uuid")).toBe(`org:${ORG_A}`);
    expect(pick("")).toBe(`org:${ORG_A}`);
    expect(selectedModelsContext([], new URLSearchParams())).toBeUndefined();
  });
});
