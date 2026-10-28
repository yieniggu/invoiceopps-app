import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { BackLink } from "../../components/BackLink";
import { LinkButton } from "../../components/LinkButton";
import { PageHeader } from "../../components/PageHeader";
import { QueryFeedback } from "../../components/QueryFeedback";
import { parseUserIds } from "../navigation/paths";
import { BulkPermissionsForm } from "../permissions/components/BulkPermissionsForm";
import type { BulkSavePermissions } from "../permissions/hooks/useSavePermissions";
import type { InvoicePermissions } from "../permissions/types";

export interface BulkPerson {
  id: string;
  name: string;
  permissions: InvoicePermissions;
}

/**
 * Bulk permission editing of the people chosen in a members list (`?userIds=`,
 * capped by `parseUserIds`). Organization and group share it; they pass the
 * people of their list and the save mutation of their level. When the save
 * fails because someone left meanwhile, the lists refresh and the screen names
 * the people who are no longer there.
 */
export function BulkPermissionsView({
  level,
  scopeName,
  eyebrow,
  backTo,
  backLabel,
  description,
  query,
  people,
  save,
  messages,
  noneFoundMessage,
  successNotice,
}: {
  level: "organization" | "group";
  scopeName: string;
  eyebrow: string;
  backTo: string;
  backLabel: string;
  description: string;
  query: {
    isPending: boolean;
    isError: boolean;
    data: unknown;
    refetch: () => Promise<unknown>;
  };
  /** The people of the list, undefined until it loads. */
  people: readonly BulkPerson[] | undefined;
  save: BulkSavePermissions;
  messages: { loading: string; error: string; retryLabel: string };
  /** Said when none of the selected people is in the list any more. */
  noneFoundMessage: string;
  successNotice: (count: number) => string;
}) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const userIds = parseUserIds(search);
  // The names of the people sent in the last attempt, to say who disappeared
  // when the refreshed list no longer has them.
  const [attempted, setAttempted] = useState<readonly BulkPerson[]>([]);

  const byId = new Map((people ?? []).map((person) => [person.id, person]));
  const found = userIds.flatMap((id) => {
    const person = byId.get(id);
    return person ? [person] : [];
  });
  const gone = save.isError ? attempted.filter(({ id }) => !byId.has(id)) : [];

  return (
    <div className="screen-stack">
      <BackLink to={backTo}>{backLabel}</BackLink>
      <PageHeader
        eyebrow={eyebrow}
        title="Editar permisos en bloque"
        description={description}
      />
      <QueryFeedback
        query={query}
        loading={messages.loading}
        error={messages.error}
        retryLabel={messages.retryLabel}
      />
      {userIds.length === 0 ? (
        <>
          <p role="alert">No hay personas seleccionadas.</p>
          <div className="action-row">
            <LinkButton to={backTo}>Volver a los miembros</LinkButton>
          </div>
        </>
      ) : people ? (
        found.length === 0 ? (
          <>
            <p role="alert">{noneFoundMessage}</p>
            {gone.length > 0 ? <p role="alert">{goneMessage(gone)}</p> : null}
            <div className="action-row">
              <LinkButton to={backTo}>Volver a los miembros</LinkButton>
            </div>
          </>
        ) : (
          <>
            {gone.length > 0 ? <p role="alert">{goneMessage(gone)}</p> : null}
            <BulkPermissionsForm
              level={level}
              scopeName={scopeName}
              people={found}
              ignoredCount={userIds.length - found.length}
              isPending={save.isPending}
              error={save.error}
              onApply={(ids, permissions) => {
                setAttempted(found);
                save.mutate(
                  { userIds: ids, permissions },
                  {
                    onSuccess: () =>
                      navigate(backTo, {
                        state: { notice: successNotice(ids.length) },
                      }),
                  },
                );
              }}
            />
          </>
        )
      ) : null}
    </div>
  );
}

function goneMessage(gone: readonly BulkPerson[]) {
  const names = gone.map(({ name }) => name).join(", ");
  return gone.length === 1
    ? `${names} ya no está disponible y se quitó de la selección. No se cambió nada; revisa la selección e intenta nuevamente.`
    : `${names} ya no están disponibles y se quitaron de la selección. No se cambió nada; revisa la selección e intenta nuevamente.`;
}
