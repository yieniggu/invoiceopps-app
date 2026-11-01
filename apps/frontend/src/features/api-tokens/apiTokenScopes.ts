import { isApiError } from "../auth/api/apiError";
import type { Profile } from "../auth/types";
import {
  invoiceScopeValue,
  type OrganizationGroups,
} from "../invoices/invoiceScopes";
import type { InvoicePermissions } from "../permissions/types";
import { API_TOKEN_SCOPES, type ApiToken, type ApiTokenScope } from "./types";

// Where a person may emit a token and with which permissions. The profile only
// decides what the form offers; the API stays the authority (403/404).

type Memberships = Pick<Profile, "memberships">;

const FLAG_BY_SCOPE = {
  "invoices:read": "readInvoices",
  "invoices:create": "createInvoices",
  "invoices:delete-own": "deleteOwnInvoices",
  "invoices:delete-others": "deleteOthersInvoices",
} as const satisfies Record<ApiTokenScope, keyof InvoicePermissions>;

export const SCOPE_LABELS: Record<ApiTokenScope, string> = {
  "invoices:read": "Leer facturas",
  "invoices:create": "Crear facturas",
  "invoices:delete-own": "Eliminar facturas propias",
  "invoices:delete-others": "Eliminar facturas de otros",
};

export const ORGANIZATION_TOKEN_LABEL = "Toda la organización";

export interface TokenScopeOption {
  /** Stable, unique `<option value>`. */
  value: string;
  label: string;
  organizationId: string;
  organizationName: string;
  /** `null` is the organization scope: the request then omits `groupId`. */
  groupId: string | null;
  /** Permissions the person holds there, in the documented order. */
  allowed: ApiTokenScope[];
}

const allowedBy = (
  ...levels: ReadonlyArray<InvoicePermissions | undefined>
): ApiTokenScope[] =>
  API_TOKEN_SCOPES.filter((scope) =>
    levels.some((level) => level?.[FLAG_BY_SCOPE[scope]]),
  );

/**
 * Scopes where the person holds at least one invoice permission, in profile
 * order: per organization the whole organization (organization flags) and its
 * groups (organization OR group effective flags). With any organization flag
 * the groups the organization lists (`organizationGroups`) join the profile's,
 * deduplicated by id.
 */
export function tokenScopeOptions(
  { memberships }: Memberships,
  organizationGroups: OrganizationGroups = new Map(),
): TokenScopeOption[] {
  return memberships.flatMap(({ organization, permissions, groups }) => {
    const { id: organizationId, name: organizationName } = organization;
    const options: TokenScopeOption[] = [];
    const push = (
      groupId: string | null,
      label: string,
      allowed: ApiTokenScope[],
    ) => {
      if (allowed.length === 0) return;
      options.push({
        value: invoiceScopeValue(
          groupId === null
            ? { kind: "organization", organizationId }
            : { kind: "group", organizationId, groupId },
        ),
        label,
        organizationId,
        organizationName,
        groupId,
        allowed,
      });
    };
    push(null, ORGANIZATION_TOKEN_LABEL, allowedBy(permissions));
    const known = new Set(groups.map(({ group }) => group.id));
    for (const { group, effective } of groups)
      push(group.id, group.name, allowedBy(permissions, effective));
    for (const group of organizationGroups.get(organizationId) ?? [])
      if (!known.has(group.id))
        push(group.id, group.name, allowedBy(permissions));
    return options;
  });
}

/** The selection that survives a change of scope: only what it allows. */
export const retainAllowed = (
  selected: readonly ApiTokenScope[],
  allowed: readonly ApiTokenScope[],
) => selected.filter((scope) => allowed.includes(scope));

export type TokenStatus = "Activo" | "Vencido" | "Revocado";

/** Revoked wins over expired: it is the person's own decision. */
export function tokenStatus(
  { expiresAt, revokedAt }: Pick<ApiToken, "expiresAt" | "revokedAt">,
  now: Date = new Date(),
): TokenStatus {
  if (revokedAt) return "Revocado";
  return Date.parse(expiresAt) <= now.getTime() ? "Vencido" : "Activo";
}

export const scopesText = (scopes: readonly ApiTokenScope[]) =>
  scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ");

/** «Toda la organización» or «Grupo X», with the names the profile knows. */
export function tokenScopeText(
  { organizationId, groupId }: Pick<ApiToken, "organizationId" | "groupId">,
  { memberships }: Memberships,
  organizationGroups: OrganizationGroups = new Map(),
) {
  if (groupId === null) return ORGANIZATION_TOKEN_LABEL;
  const fromProfile = memberships
    .filter(({ organization }) => organization.id === organizationId)
    .flatMap(({ groups }) => groups)
    .find(({ group }) => group.id === groupId)?.group;
  const listed = organizationGroups
    .get(organizationId)
    ?.find(({ id }) => id === groupId);
  const name = fromProfile?.name ?? listed?.name;
  return name ? `Grupo ${name}` : "Un grupo de la organización";
}

export type TokenAction = "issue" | "revoke";

export const EXPIRY_REFUSED =
  "La caducidad debe ser futura y de máximo 29 días.";

/**
 * The server refused the expiry (400 with a message on `fields.expiresAt`):
 * the device clock and the server's disagree, or the date left the window.
 * The text belongs on the expiry field, not in the generic alert.
 */
export function expiryRefusal(error: unknown) {
  return isApiError(error) &&
    error.status === 400 &&
    typeof error.fields?.expiresAt === "string"
    ? EXPIRY_REFUSED
    : undefined;
}

/** Spanish text for a failed emission or revocation; the body never shows. */
export function describeTokenFailure(error: unknown, action: TokenAction) {
  const status = isApiError(error) ? error.status : undefined;
  if (action === "revoke") {
    if (status === 404) return "El token ya no existe o no te pertenece.";
    if (status === 503)
      return "El sistema está ocupado. Espera unos segundos e intenta nuevamente.";
    return status === undefined
      ? "No fue posible conectar con el servidor. Revisa tu conexión e intenta nuevamente."
      : "No fue posible revocar el token. Intenta nuevamente.";
  }
  if (status === 400)
    return "Revisa los datos del token (nombre, permisos y caducidad) e intenta nuevamente.";
  if (status === 403)
    return "Ya no tienes permiso para emitir este token en ese alcance. Estamos actualizando tus permisos.";
  if (status === 409 && isApiError(error) && error.code === "TOKEN_LIMIT")
    return "Llegaste al máximo de 50 tokens activos en esta organización. Revoca uno para emitir otro.";
  if (status === 429)
    return "Emitiste demasiados tokens seguidos. Espera unos minutos e inténtalo de nuevo.";
  if (status === 404)
    return "No encontramos la organización o el grupo elegido. Es posible que ya no exista o que no tengas acceso a él.";
  if (status === 503)
    return "El sistema está ocupado y no pudimos emitir el token. Espera unos segundos e intenta nuevamente.";
  return status === undefined
    ? "No fue posible conectar con el servidor. Revisa tu conexión: si el token se emitió, no podrás verlo; revócalo desde la lista y emite otro."
    : "No fue posible emitir el token. Intenta nuevamente.";
}
