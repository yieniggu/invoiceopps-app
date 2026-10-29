import { MAX_TOTAL_GROUP_GRANTS } from "../../../lib/limits";
import { isValidRut, toApiRut } from "../../../lib/rut";
import type { OrganizationRole } from "../../auth/types";
import {
  NO_PERMISSIONS,
  type InvoicePermissions,
} from "../../permissions/types";
import type {
  CreateUserInput,
  ProvisionUserInput,
  UserMembershipInput,
} from "../types";

/** Local form state of the create-user wizard (never sent as is). */
export interface GroupDraft {
  key: string;
  /** "" until a group is chosen. */
  groupId: string;
  /** Label of the chosen group, for the summary. */
  groupName: string;
  permissions: InvoicePermissions;
}

/** An organization that can be chosen for the new user. */
export interface OrganizationOption {
  id: string;
  name: string;
  /** Shown next to the name in pickers to tell similar names apart. */
  slug?: string;
}

/** "Name (slug)" when the slug is known, otherwise just the name. */
export const organizationOptionLabel = ({ name, slug }: OrganizationOption) =>
  slug ? `${name} (${slug})` : name;

export interface OrganizationDraft {
  key: string;
  /** "" until an organization is chosen. */
  organizationId: string;
  /**
   * What the choice looked like when it was made (name, slug). An organization
   * found by searching is not in the preloaded page, so the draft carries it:
   * the card, the groups step and the summary can name it without it.
   */
  picked?: OrganizationOption;
  role: OrganizationRole;
  permissions: InvoicePermissions;
  groups: GroupDraft[];
}

/** "generated": the server makes the temporary password; "defined": the admin types it. */
export type PasswordMode = "generated" | "defined";

export interface UserDraft {
  name: string;
  rut: string;
  passwordMode: PasswordMode;
  /** Only meaningful in "defined" mode; never part of the request metadata. */
  temporaryPassword: string;
  temporaryPasswordRepeat: string;
  organizations: OrganizationDraft[];
}

export const MAX_ORGANIZATIONS = 50;
export const MIN_TEMPORARY_PASSWORD_LENGTH = 8;
export const MAX_TEMPORARY_PASSWORD_LENGTH = 256;
export const TEMPORARY_PASSWORD_LENGTH_MESSAGE = `La contraseña temporal debe tener entre ${MIN_TEMPORARY_PASSWORD_LENGTH} y ${MAX_TEMPORARY_PASSWORD_LENGTH} caracteres.`;

let sequence = 0;
const nextKey = () => `draft-${++sequence}`;

export const emptyGroup = (): GroupDraft => ({
  key: nextKey(),
  groupId: "",
  groupName: "",
  permissions: NO_PERMISSIONS,
});

export const emptyOrganization = (
  organizationId = "",
  picked?: OrganizationOption,
): OrganizationDraft => ({
  key: nextKey(),
  organizationId,
  picked,
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [],
});

export const emptyUser = (
  organizationId?: string,
  picked?: OrganizationOption,
): UserDraft => ({
  name: "",
  rut: "",
  passwordMode: "generated",
  temporaryPassword: "",
  temporaryPasswordRepeat: "",
  organizations: organizationId
    ? [emptyOrganization(organizationId, picked)]
    : [],
});

export interface DataErrors {
  name: string;
  rut: string;
  password: string;
  repeat: string;
}

export function validateData(draft: UserDraft): DataErrors {
  const defined = draft.passwordMode === "defined";
  const length = draft.temporaryPassword.length;
  return {
    password:
      defined &&
      (length < MIN_TEMPORARY_PASSWORD_LENGTH ||
        length > MAX_TEMPORARY_PASSWORD_LENGTH)
        ? TEMPORARY_PASSWORD_LENGTH_MESSAGE
        : "",
    repeat:
      defined && draft.temporaryPasswordRepeat !== draft.temporaryPassword
        ? "Las contraseñas no coinciden."
        : "",
    name: draft.name.trim() ? "" : "Ingresa el nombre completo.",
    rut: !draft.rut
      ? "Ingresa el RUT"
      : isValidRut(draft.rut)
        ? ""
        : "RUT inválido",
  };
}

export const STALE_ORGANIZATION_MESSAGE =
  "Esta organización ya no está disponible. Elige otra o quítala.";
export const STALE_GROUP_MESSAGE =
  "Este grupo ya no existe en la organización. Elige otro o quítalo.";
export const GROUP_LIMIT_MESSAGE = `Un usuario puede tener hasta ${MAX_TOTAL_GROUP_GRANTS} grupos en total entre todas sus organizaciones. Quita este grupo o alguno de los anteriores.`;
export const GROUPS_NOT_LOADED_MESSAGE =
  "Los grupos de esta organización aún no se cargan. Espera o reintenta antes de continuar.";

/**
 * Organization drafts whose organization is no longer among the loaded
 * options (it was deleted or became invisible after a refresh). They are
 * flagged, never silently dropped: the person decides what to do with the
 * role and permissions they had filled in.
 */
export function staleOrganizations(
  draft: UserDraft,
  options: ReadonlyArray<{ id: string }>,
  /**
   * The options are every organization there is. When they are only the first
   * page of a longer list, an organization missing from them may simply be
   * further down (it was found by searching), so nothing can be said about it
   * here: the server's 404 at submit time catches a vanished one.
   */
  complete = true,
): Record<string, string> {
  const known = new Set(options.map(({ id }) => id));
  const stale: Record<string, string> = {};
  if (!complete) return stale;
  for (const organization of draft.organizations)
    if (organization.organizationId && !known.has(organization.organizationId))
      stale[organization.key] = STALE_ORGANIZATION_MESSAGE;
  return stale;
}

/** Groups of each organization that have been loaded, by organization id. */
export type GroupOptions = ReadonlyMap<string, ReadonlyArray<{ id: string }>>;

/**
 * Group drafts whose group cannot be confirmed: it is no longer in the loaded
 * groups of its organization, or those groups are not loaded (still loading,
 * or failed to load), so the choice cannot be verified and must not pass.
 */
export function staleGroups(
  draft: UserDraft,
  groupOptions: GroupOptions,
): Record<string, string> {
  const stale: Record<string, string> = {};
  for (const organization of draft.organizations) {
    const loaded = groupOptions.get(organization.organizationId);
    if (!loaded) {
      for (const group of organization.groups)
        if (group.groupId) stale[group.key] = GROUPS_NOT_LOADED_MESSAGE;
      continue;
    }
    const known = new Set(loaded.map(({ id }) => id));
    for (const group of organization.groups)
      if (group.groupId && !known.has(group.groupId))
        stale[group.key] = STALE_GROUP_MESSAGE;
  }
  return stale;
}

/**
 * Step 2: errors per organization draft key; an empty object means valid. The
 * organization must be one of the loaded options.
 */
export function validateOrganizations(
  draft: UserDraft,
  options: ReadonlyArray<{ id: string }>,
  complete = true,
): Record<string, { organization: string }> {
  const errors: Record<string, { organization: string }> = {};
  for (const organization of draft.organizations)
    if (!organization.organizationId)
      errors[organization.key] = {
        organization: "Selecciona una organización.",
      };
  for (const [key, organization] of Object.entries(
    staleOrganizations(draft, options, complete),
  ))
    errors[key] = { organization };
  return errors;
}

/** Group drafts of every organization: what the server counts against its cap. */
export const countGroupGrants = (draft: UserDraft): number =>
  draft.organizations.reduce(
    (total, organization) => total + organization.groups.length,
    0,
  );

/**
 * Step 3: group error message per group draft key; empty means valid. The
 * group must still exist in the loaded groups of its organization, and the
 * groups of all organizations together stay within the server's cap (the
 * drafts past the cap are the ones flagged).
 */
export function validateGroups(
  draft: UserDraft,
  groupOptions: GroupOptions,
): Record<string, string> {
  const errors: Record<string, string> = {};
  let counted = 0;
  for (const organization of draft.organizations)
    for (const group of organization.groups) {
      if (!group.groupId) errors[group.key] = "Selecciona un grupo.";
      counted += 1;
      if (counted > MAX_TOTAL_GROUP_GRANTS)
        errors[group.key] = GROUP_LIMIT_MESSAGE;
    }
  return { ...errors, ...staleGroups(draft, groupOptions) };
}

/** The admin-defined temporary password, or undefined when it is generated. */
export const definedPasswordOf = (draft: UserDraft): string | undefined =>
  draft.passwordMode === "defined" ? draft.temporaryPassword : undefined;

const membershipOf = (
  organization: OrganizationDraft,
): UserMembershipInput => ({
  organizationId: organization.organizationId,
  role: organization.role,
  permissions: { ...organization.permissions },
  groups: organization.groups.map(({ groupId, permissions }) => ({
    groupId,
    permissions: { ...permissions },
  })),
});

/**
 * Metadata of POST /admin/users; flags are always sent explicitly. It never
 * carries the temporary password: that secret travels through the transport
 * outbox (see `useSecretOutbox`) so mutation variables stay free of it.
 */
export const toPlatformInput = (draft: UserDraft): CreateUserInput => ({
  name: draft.name.trim(),
  rut: toApiRut(draft.rut),
  memberships: draft.organizations.map(membershipOf),
});

/** Metadata of POST /organizations/{o}/users (no password, see above). */
export function toOrganizationInput(draft: UserDraft): ProvisionUserInput {
  const { role, permissions, groups } = membershipOf(draft.organizations[0]);
  return {
    name: draft.name.trim(),
    rut: toApiRut(draft.rut),
    role,
    permissions,
    groups,
  };
}
