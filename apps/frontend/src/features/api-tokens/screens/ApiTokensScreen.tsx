import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { PageHeader } from "../../../components/PageHeader";
import { PaginationControls } from "../../../components/PaginationControls";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { Toast } from "../../../components/Toast";
import { isUuid } from "../../../lib/uuid";
import type { Profile } from "../../auth/types";
import {
  parsePage,
  useOutOfRangeRedirect,
} from "../../navigation/useListParams";
import { ApiTokenSecretDialog } from "../components/ApiTokenSecretDialog";
import { ApiTokenTable } from "../components/ApiTokenTable";
import { IssueApiTokenDialog } from "../components/IssueApiTokenDialog";
import { RevokeApiTokenDialog } from "../components/RevokeApiTokenDialog";
import { useApiTokenScopeOptions } from "../hooks/useApiTokenScopeOptions";
import { useApiTokensQuery } from "../hooks/useApiTokens";
import { useIssueApiToken } from "../hooks/useIssueApiToken";
import { useRevokeApiToken } from "../hooks/useRevokeApiToken";
import type { ApiToken } from "../types";

const PAGE_SIZE = 20;
/** What the person must know about a token whose secret they never saw. */
const abandonedNotice = (organizationName: string | undefined) =>
  `Se emitió un token${organizationName ? ` en ${organizationName}` : ""} que no alcanzaste a ver. Revócalo desde la lista si no lo vas a usar.`;
const DESCRIPTION =
  "Credenciales para que tus integraciones usen la API de facturas sin tu contraseña. Cada token tiene un alcance, permisos y una caducidad de hasta 29 días.";

/**
 * Own API tokens: list, emission and revocation. The secret of a new token
 * is shown once, in its own dialog, and never reaches a cache (see
 * `useIssueApiToken`).
 */
export function ApiTokensScreen({ profile }: { profile: Profile }) {
  if (profile.memberships.length === 0)
    return (
      <div className="screen-stack">
        <PageHeader title="Tokens de API" description={DESCRIPTION} />
        <p role="status">
          Necesitas pertenecer a una organización para emitir tokens de API.
          Pide a un administrador que te agregue a una.
        </p>
      </div>
    );
  return <ApiTokensContainer profile={profile} />;
}

function ApiTokensContainer({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requested = params.get("organizationId");
  const firstOrganizationId = profile.memberships[0].organization.id;
  const organization = (
    profile.memberships.find(
      ({ organization: { id } }) =>
        requested !== null && isUuid(requested) && id === requested,
    ) ?? profile.memberships[0]
  ).organization;
  const page = parsePage(params.get("page"));

  // Only what differs from the defaults travels in the URL.
  const searchFor = (organizationId: string, target: number) => {
    const query = new URLSearchParams();
    if (organizationId !== firstOrganizationId)
      query.set("organizationId", organizationId);
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `?${text}` : "?";
  };

  const tokens = useApiTokensQuery({
    organizationId: organization.id,
    page,
    pageSize: PAGE_SIZE,
  });
  const { options, organizationGroups } = useApiTokenScopeOptions(profile);
  // One arrival per abandoned emission, so the same text can show again.
  const [abandoned, setAbandoned] = useState<{
    count: number;
    organizationId?: string;
  }>({ count: 0 });
  const issue = useIssueApiToken({
    onAbandoned: ({ organizationId }) =>
      setAbandoned(({ count }) => ({ count: count + 1, organizationId })),
  });
  const revoke = useRevokeApiToken();

  const [formOpen, setFormOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken>();
  const [notice, setNotice] = useState("");
  const issueTrigger = useRef<HTMLButtonElement>(null);
  const revokeTrigger = useRef<HTMLElement | null>(null);

  const items = tokens.data?.items ?? [];
  const outOfRange = useOutOfRangeRedirect(
    {
      page,
      pageSize: tokens.data?.pageSize || PAGE_SIZE,
      total: tokens.data?.total,
      rowCount: items.length,
      settled: !!tokens.data && !tokens.isPlaceholderData,
    },
    (last) => searchFor(organization.id, last),
  );

  const closeIssue = () => {
    issue.discard();
    setFormOpen(false);
  };
  const closeRevoke = () => {
    revoke.reset();
    setRevoking(undefined);
  };

  return (
    <div className="screen-stack screen-fill">
      <PageHeader
        title="Tokens de API"
        description={DESCRIPTION}
        action={
          options.length > 0 ? (
            <button
              ref={issueTrigger}
              type="button"
              onClick={() => {
                setNotice("");
                setFormOpen(true);
              }}
            >
              Emitir token
            </button>
          ) : undefined
        }
      />
      <p role="status" className="visually-hidden">
        {notice}
      </p>
      {/* A warning that stays until dismissed, in the page flow above the
          list: it never covers the paginator at the bottom. */}
      <Toast
        tone="warning"
        persistent
        message={
          abandoned.count > 0
            ? abandonedNotice(
                profile.memberships.find(
                  ({ organization: { id } }) => id === abandoned.organizationId,
                )?.organization.name,
              )
            : undefined
        }
        noticeId={`abandoned-${abandoned.count}`}
      />
      {options.length === 0 ? (
        <p role="status">
          No tienes permisos sobre facturas en tus organizaciones, así que no
          puedes emitir tokens. Pide a un administrador que te los otorgue.
        </p>
      ) : null}
      {profile.memberships.length > 1 ? (
        <div className="form-field">
          <label htmlFor="api-tokens-organization">Organización</label>
          <select
            id="api-tokens-organization"
            value={organization.id}
            onChange={(event) => navigate(searchFor(event.target.value, 1))}
          >
            {profile.memberships.map(({ organization: { id, name } }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <QueryFeedback
        query={tokens}
        loading="Cargando tokens..."
        error="No fue posible cargar los tokens."
        staleError="No fue posible actualizar la lista de tokens; lo que ves puede estar desactualizado."
        retryLabel="Reintentar tokens"
      />
      {tokens.data &&
      !tokens.isPlaceholderData &&
      items.length === 0 &&
      !outOfRange ? (
        <p>No tienes tokens en {organization.name}.</p>
      ) : null}
      {items.length > 0 ? (
        <ApiTokenTable
          tokens={items}
          profile={profile}
          organizationGroups={organizationGroups}
          busy={tokens.isPlaceholderData}
          onRevoke={(token, trigger) => {
            revokeTrigger.current = trigger;
            setNotice("");
            setRevoking(token);
          }}
        />
      ) : null}
      {tokens.data ? (
        <PaginationControls
          page={page}
          pageSize={tokens.data.pageSize || PAGE_SIZE}
          total={tokens.data.total}
          busy={tokens.isPlaceholderData}
          onPageChange={(next) => navigate(searchFor(organization.id, next))}
        />
      ) : null}
      {issue.issued ? (
        <ApiTokenSecretDialog
          key={issue.issued.token.id}
          issued={issue.issued}
          onClose={closeIssue}
          returnFocusTo={issueTrigger}
        />
      ) : formOpen ? (
        <IssueApiTokenDialog
          options={options}
          pending={issue.pending}
          failure={issue.isError ? { error: issue.error } : undefined}
          onSubmit={issue.issue}
          onClose={closeIssue}
          returnFocusTo={issueTrigger}
        />
      ) : null}
      {revoking ? (
        <RevokeApiTokenDialog
          token={revoking}
          pending={revoke.isPending}
          failure={revoke.isError ? { error: revoke.error } : undefined}
          onConfirm={() =>
            revoke.mutate(revoking.id, {
              onSuccess: () => {
                setRevoking(undefined);
                setNotice("Token revocado.");
              },
            })
          }
          onClose={closeRevoke}
          returnFocusTo={revokeTrigger}
        />
      ) : null}
    </div>
  );
}
