import type { OrganizationRole } from "../../auth/types";

/** How a role reads in organization and group screens. */
export function memberRoleLabel(role: string) {
  return role === "ADMIN" ? "Administrador" : "Miembro";
}

export const isAdminRole = (
  role: string | undefined,
): role is OrganizationRole => role === "ADMIN";
