import { namedId } from "../../../test/ids";
import { describe, expect, it } from "vitest";

import { MAX_TOTAL_GROUP_GRANTS } from "../../../lib/limits";
import {
  GROUP_LIMIT_MESSAGE,
  GROUPS_NOT_LOADED_MESSAGE,
  STALE_GROUP_MESSAGE,
  countGroupGrants,
  emptyGroup,
  emptyOrganization,
  emptyUser,
  validateGroups,
  type GroupOptions,
  type UserDraft,
} from "./draft";

/** A draft with `perOrganization[i]` chosen groups in organization i. */
function draftWith(perOrganization: number[]): {
  draft: UserDraft;
  options: GroupOptions;
} {
  const draft = emptyUser();
  const options = new Map<string, Array<{ id: string }>>();
  perOrganization.forEach((count, index) => {
    const organization = emptyOrganization(namedId("org", index));
    const ids = Array.from({ length: count }, (_u, n) => `g-${index}-${n}`);
    organization.groups = ids.map((groupId) => ({
      ...emptyGroup(),
      groupId,
      groupName: groupId,
    }));
    options.set(
      organization.organizationId,
      ids.map((id) => ({ id })),
    );
    draft.organizations.push(organization);
  });
  return { draft, options };
}

describe("group grants of the create-user wizard (CR-251)", () => {
  it("counts the groups of every organization", () => {
    expect(countGroupGrants(draftWith([]).draft)).toBe(0);
    expect(countGroupGrants(draftWith([3, 0, 5]).draft)).toBe(8);
  });

  it("accepts exactly the cap, spread over several organizations", () => {
    const { draft, options } = draftWith([120, 80]);
    expect(countGroupGrants(draft)).toBe(MAX_TOTAL_GROUP_GRANTS);
    expect(validateGroups(draft, options)).toEqual({});
  });

  it("flags the drafts past the cap, in order, and only those", () => {
    const { draft, options } = draftWith([150, 51]);
    const errors = validateGroups(draft, options);
    const last = draft.organizations[1].groups;
    expect(Object.keys(errors)).toEqual([last[last.length - 1].key]);
    expect(Object.values(errors)).toEqual([GROUP_LIMIT_MESSAGE]);
    expect(GROUP_LIMIT_MESSAGE).toContain(String(MAX_TOTAL_GROUP_GRANTS));
  });
});

describe("groups that are not loaded (CR-258)", () => {
  it("flags a chosen group whose organization's groups are not loaded", () => {
    const { draft } = draftWith([2]);
    const errors = validateGroups(draft, new Map());
    expect(Object.values(errors)).toEqual([
      GROUPS_NOT_LOADED_MESSAGE,
      GROUPS_NOT_LOADED_MESSAGE,
    ]);
  });

  it("flags only the group that is missing once the groups are loaded", () => {
    const { draft } = draftWith([2]);
    const [first, second] = draft.organizations[0].groups;
    const errors = validateGroups(
      draft,
      new Map([
        ["00000000-0000-4000-9000-000000000000", [{ id: first.groupId }]],
      ]),
    );
    expect(errors).toEqual({ [second.key]: STALE_GROUP_MESSAGE });
  });

  it("does not flag an organization with no group drafts", () => {
    const { draft } = draftWith([0]);
    expect(validateGroups(draft, new Map())).toEqual({});
  });
});
