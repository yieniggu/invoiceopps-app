import { isUnauthorized } from "../../auth/api/apiError";
import type { GroupPermissions } from "../types";
import { addGroupMember, updateGroupPermissions } from "./groupsApi";

export interface SetupMember {
  userId: string;
  name: string;
}

/** What still has to be applied to a group that already exists. */
export interface GroupSetup {
  permissions?: GroupPermissions;
  members: SetupMember[];
}

/**
 * Applies permissions and then each membership, strictly one after another.
 * Every step settles on its own: what failed is returned so the person can
 * retry exactly that. A 401 is rethrown so the session ends as usual.
 */
export async function runGroupSetup(
  organizationId: string,
  groupId: string,
  setup: GroupSetup,
): Promise<GroupSetup> {
  const failed: GroupSetup = { members: [] };
  if (setup.permissions) {
    try {
      await updateGroupPermissions(organizationId, groupId, setup.permissions);
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      failed.permissions = setup.permissions;
    }
  }
  for (const member of setup.members) {
    try {
      await addGroupMember(organizationId, groupId, member.userId);
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      failed.members.push(member);
    }
  }
  return failed;
}

export const isSetupComplete = (setup: GroupSetup) =>
  !setup.permissions && setup.members.length === 0;
