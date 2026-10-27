import { apiRequest } from "../../auth/api/apiRequest";
import type {
  IssuedCredential,
  OrganizationUser,
  ProvisionedUser,
  ProvisionUserInput,
} from "../types";

const base = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}/users`;

export const listOrganizationUsers = (
  organizationId: string,
  signal?: AbortSignal,
) =>
  apiRequest<{ users: OrganizationUser[] }>(base(organizationId), {
    signal,
  }).then((result) => result.users);

/**
 * Transport function for provisioning. The temporary password is extracted
 * here and handed to `deliver`; the returned promise resolves metadata only,
 * so the secret never reaches a mutation result, variable or cache.
 */
export async function provisionUser(
  organizationId: string,
  input: ProvisionUserInput,
  deliver: (credential: IssuedCredential) => void,
): Promise<ProvisionedUser> {
  const { user, membership, temporaryPassword } = await apiRequest<{
    user: { id: string; name: string };
    membership: { role: ProvisionedUser["role"] };
    temporaryPassword: string;
  }>(base(organizationId), { method: "POST", body: input });
  deliver({ userId: user.id, name: user.name, temporaryPassword });
  return { userId: user.id, role: membership.role };
}
