import { DataTable, type DataColumn } from "../../../components/DataTable";
import type { OrganizationGroups } from "../../invoices/invoiceScopes";
import type { Profile } from "../../auth/types";
import { formatInstant } from "../../../lib/datetime";
import {
  scopesText,
  tokenScopeText,
  tokenStatus,
  type TokenStatus,
} from "../apiTokenScopes";
import type { ApiToken } from "../types";

const TONES: Record<TokenStatus, string> = {
  Activo: "is-approved",
  Vencido: "is-pending",
  Revocado: "is-rejected",
};

/** Own tokens as metadata; the secret is not part of any row. */
export function ApiTokenTable({
  tokens,
  profile,
  organizationGroups,
  busy,
  onRevoke,
}: {
  tokens: readonly ApiToken[];
  profile: Profile;
  organizationGroups: OrganizationGroups;
  busy: boolean;
  onRevoke: (token: ApiToken, trigger: HTMLButtonElement) => void;
}) {
  const now = new Date();
  const columns: DataColumn<ApiToken>[] = [
    { header: "Nombre", cell: ({ name }) => name },
    {
      header: "Alcance",
      cell: (token) => tokenScopeText(token, profile, organizationGroups),
    },
    { header: "Permisos", cell: ({ scopes }) => scopesText(scopes) },
    { header: "Creado", cell: ({ createdAt }) => formatInstant(createdAt) },
    { header: "Vence", cell: ({ expiresAt }) => formatInstant(expiresAt) },
    {
      header: "Estado",
      cell: (token) => {
        const status = tokenStatus(token, now);
        return (
          <span className={`status-badge ${TONES[status]}`}>{status}</span>
        );
      },
    },
    {
      header: "Acciones",
      cell: (token) =>
        token.revokedAt ? null : (
          <button
            type="button"
            className="danger-button"
            aria-label={`Revocar token ${token.name}`}
            onClick={(event) => onRevoke(token, event.currentTarget)}
          >
            Revocar
          </button>
        ),
    },
  ];
  return (
    <DataTable
      label="Tokens de API de la organización"
      rows={tokens}
      columns={columns}
      busy={busy}
    />
  );
}
