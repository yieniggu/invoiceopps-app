import { apiRequest } from "../../auth/api/apiRequest";
import type { IssuedCredential } from "../../users/types";
import type {
  AdminUserDetail,
  AdminUserPage,
  AdminUsersRequest,
  PasswordResetResult,
  UpdateAdminUserInput,
} from "../types";

const base = (userId: string) =>
  `/api/v1/admin/users/${encodeURIComponent(userId)}`;

export const listAdminUsers = (
  { search, status, page, pageSize }: AdminUsersRequest,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams({
    status,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (search) query.set("search", search);
  return apiRequest<AdminUserPage>(`/api/v1/admin/users?${query}`, { signal });
};

export const getAdminUser = (userId: string, signal?: AbortSignal) =>
  apiRequest<AdminUserDetail>(base(userId), { signal });

export const updateAdminUser = (userId: string, input: UpdateAdminUserInput) =>
  apiRequest<{ user: { id: string; name: string } }>(base(userId), {
    method: "PATCH",
    body: input,
  }).then(({ user }) => ({ userId: user.id, name: user.name }));

/**
 * The server answers with the one-time temporary password. It is extracted
 * here and handed to `deliver`; the returned promise resolves metadata only
 * (like `postAndDeliver` in usersApi), so the secret never reaches a query
 * result, a mutation result or a variable.
 */
export async function resetAdminUserPassword(
  user: { id: string; name: string },
  deliver: (credential: IssuedCredential) => void,
): Promise<PasswordResetResult> {
  const { temporaryPassword, expiresAt } = await apiRequest<{
    temporaryPassword?: string;
    expiresAt: string;
  }>(`${base(user.id)}/password-reset`, { method: "POST", body: {} });
  if (temporaryPassword !== undefined)
    deliver({ userId: user.id, name: user.name, temporaryPassword });
  return { expiresAt };
}

export const setAdminUserDeactivation = (userId: string, disabled: boolean) =>
  apiRequest<{ user: { id: string; disabledAt: string | null } }>(
    `${base(userId)}/deactivation`,
    { method: disabled ? "POST" : "DELETE" },
  ).then(({ user }) => ({ userId: user.id, disabledAt: user.disabledAt }));
