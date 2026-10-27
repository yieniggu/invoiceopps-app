import type { OrganizationRole } from "../../auth/types";

export interface OrganizationUser {
  id: string;
  name: string;
  rut: string;
  role: OrganizationRole;
}

export interface ProvisionUserInput {
  name: string;
  rut: string;
  role: OrganizationRole;
}

/** What the server shows once; it only ever travels to the dialog callback. */
export interface IssuedCredential {
  userId: string;
  name: string;
  temporaryPassword: string;
}

/** The only thing a provisioning mutation resolves with. */
export interface ProvisionedUser {
  userId: string;
  role: OrganizationRole;
}
