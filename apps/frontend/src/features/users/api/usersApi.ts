import { withQuery } from "../../../lib/pagination";
import { apiRequest } from "../../auth/api/apiRequest";
import type { PageRequest } from "../../orgs/types";
import type {
  CreateUserInput,
  IssuedCredential,
  OrganizationUserPage,
  ProvisionedUser,
  ProvisionUserInput,
} from "../types";

const base = (organizationId: string) =>
  `/api/v1/organizations/${encodeURIComponent(organizationId)}/users`;

/** One page of the organization's people; `search` is a name or RUT fragment. */
export const listOrganizationUsersPage = (
  organizationId: string,
  params: PageRequest & { search?: string },
  signal?: AbortSignal,
) =>
  apiRequest<OrganizationUserPage>(withQuery(base(organizationId), params), {
    signal,
  });

/**
 * Both provisioning endpoints answer with the user and, when the server
 * generated the password, a one-time temporary password. It is extracted here
 * and handed to `deliver`; an admin-defined password is never echoed. The
 * returned promise resolves metadata only, so the secret never reaches a
 * mutation result, variable or cache.
 */
async function postAndDeliver(
  path: string,
  input: object,
  deliver: (credential: IssuedCredential) => void,
  definedTemporaryPassword: string | undefined,
): Promise<ProvisionedUser> {
  // The admin-defined password joins the body only here, at send time.
  const body =
    definedTemporaryPassword === undefined
      ? input
      : { ...input, temporaryPassword: definedTemporaryPassword };
  const { user, temporaryPassword } = await apiRequest<{
    user: { id: string; name: string };
    temporaryPassword?: string;
  }>(path, { method: "POST", body });
  // The server answers with a password only when it generated one.
  if (temporaryPassword !== undefined)
    deliver({ userId: user.id, name: user.name, temporaryPassword });
  return { userId: user.id, name: user.name };
}

export const provisionUser = (
  organizationId: string,
  input: ProvisionUserInput,
  deliver: (credential: IssuedCredential) => void,
  definedTemporaryPassword?: string,
) =>
  postAndDeliver(
    base(organizationId),
    input,
    deliver,
    definedTemporaryPassword,
  );

/** Platform-only: a user with any number of organizations and groups. */
export const createPlatformUser = (
  input: CreateUserInput,
  deliver: (credential: IssuedCredential) => void,
  definedTemporaryPassword?: string,
) =>
  postAndDeliver(
    "/api/v1/admin/users",
    input,
    deliver,
    definedTemporaryPassword,
  );
