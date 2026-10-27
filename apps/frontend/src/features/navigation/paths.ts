/** Every URL the app serves; screens link through these builders only. */
const segment = encodeURIComponent;

export const paths = {
  panel: "/panel",
  invoices: "/facturas",
  policies: "/politicas",
  profile: "/perfil",
  changePassword: "/cambiar-contrasena",
  organizations: "/organizaciones",
  newOrganization: "/organizaciones/nueva",
  organization: (organizationId: string) =>
    `/organizaciones/${segment(organizationId)}`,
  organizationGroups: (organizationId: string) =>
    `/organizaciones/${segment(organizationId)}/grupos`,
  newGroup: (organizationId: string) =>
    `/organizaciones/${segment(organizationId)}/grupos/nuevo`,
  group: (organizationId: string, groupId: string) =>
    `/organizaciones/${segment(organizationId)}/grupos/${segment(groupId)}`,
  groups: "/grupos",
} as const;

/** One-shot message handed to the next screen through navigation state. */
export interface RouteNotice {
  notice?: string;
}
