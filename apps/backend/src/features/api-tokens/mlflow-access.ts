import type { Prisma } from "../../generated/prisma/client.js";

/**
 * MLflow scope rule (MLOPS-01): a user may hold `mlflow:read` / `mlflow:write`
 * in a context while they are an active member of it. Active means: user not
 * deactivated and past onboarding, organization enabled AND its Models section
 * on (`mlEnabled`: MLflow is part of that section, so switching it off ends
 * every MLflow access of the organization), organization membership present
 * and, for a group token, group membership present.
 * Invoice permission flags do not matter and the role (ADMIN included) grants
 * nothing extra; the platform administrator needs a membership like anyone.
 *
 * Used at emission (inside the serializable transaction, memberships locked)
 * and at introspection (current state on every call, so a removed member's
 * token stops being valid immediately on the app side).
 */
export async function hasMlflowAccess(
  database: Prisma.TransactionClient,
  input: { userId: string; organizationId: string; groupId: string | null },
): Promise<boolean> {
  const membership = await database.organizationMembership.findFirst({
    where: {
      userId: input.userId,
      organizationId: input.organizationId,
      user: { disabledAt: null, mustChangePassword: false },
      organization: { enabled: true, mlEnabled: true },
      ...(input.groupId === null
        ? {}
        : { groupMemberships: { some: { groupId: input.groupId } } }),
    },
    select: { id: true },
  });
  return membership !== null;
}
