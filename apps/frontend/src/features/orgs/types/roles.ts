import type { OrganizationRole } from "../../auth/types";

/** How a role reads everywhere (screens, role selects, wizard summaries). */
export function memberRoleLabel(role: string) {
  return role === "ADMIN" ? "Administrador" : "Usuario";
}

export const isAdminRole = (
  role: string | undefined,
): role is OrganizationRole => role === "ADMIN";
