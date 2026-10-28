import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { QueryFeedback } from "../../components/QueryFeedback";
import {
  SelectionTable,
  type SelectionColumn,
} from "../../components/SelectionTable";
import { useIdSelection } from "../../hooks/useIdSelection";
import { MAX_BULK_MEMBERS } from "../../lib/limits";
import { useRouteNotice } from "../navigation/useRouteNotice";

/** What both member lists share: a person with a stable id and a name. */
interface Person {
  user: { id: string; name: string };
}

export type MemberRow<Member extends Person> = Member & {
  id: string;
  name: string;
};

interface MembersQuery<Member> {
  data: Member[] | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
}

/**
 * The members list of an organization or of a group: header, the one-shot
 * notice of the previous action, load feedback, a selection table and the
 * "edit permissions in bulk" action. The two screens differ only in the data,
 * the columns and the labels they pass in.
 */
export function MembersTableScreen<Member extends Person>({
  query,
  backTo,
  backLabel,
  eyebrow,
  title,
  description,
  action,
  messages,
  tableLabel,
  columns,
  bulkPath,
}: {
  query: MembersQuery<Member>;
  backTo: string;
  backLabel: string;
  eyebrow: string;
  title: string;
  description: string;
  /** The "add" link button of the header. */
  action: ReactNode;
  messages: {
    loading: string;
    error: string;
    staleError: string;
    retryLabel: string;
    empty: string;
  };
  tableLabel: string;
  columns: SelectionColumn<MemberRow<Member>>[];
  /** URL of the bulk permissions screen for the selected people. */
  bulkPath: (userIds: string[]) => string;
}) {
  const navigate = useNavigate();
  const notice = useRouteNotice();
  const rows: MemberRow<Member>[] = (query.data ?? []).map((member) => ({
    ...member,
    id: member.user.id,
    name: member.user.name,
  }));
  const selection = useIdSelection(rows.map(({ id }) => id));
  const count = selection.selected.length;

  return (
    <div className="screen-stack">
      <BackLink to={backTo}>{backLabel}</BackLink>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        action={action}
      />
      {notice ? <p role="status">{notice}</p> : null}
      <QueryFeedback
        query={query}
        loading={messages.loading}
        error={messages.error}
        staleError={messages.staleError}
        retryLabel={messages.retryLabel}
      />
      {query.data && rows.length === 0 ? <p>{messages.empty}</p> : null}
      {rows.length > 0 ? (
        <>
          <div className="action-row">
            <button
              type="button"
              disabled={count === 0 || count > MAX_BULK_MEMBERS}
              onClick={() => navigate(bulkPath(selection.selected))}
            >
              Editar permisos en bloque
            </button>
            <p role="status" aria-live="polite" className="muted">
              {count === 0
                ? "Selecciona personas para editar sus permisos en bloque."
                : count > MAX_BULK_MEMBERS
                  ? `Selecciona hasta ${MAX_BULK_MEMBERS} personas por operación.`
                  : count === 1
                    ? "1 persona seleccionada."
                    : `${count} personas seleccionadas.`}
            </p>
          </div>
          <SelectionTable
            label={tableLabel}
            rows={rows}
            columns={columns}
            isSelected={selection.isSelected}
            allSelected={selection.allSelected}
            someSelected={selection.someSelected}
            onToggle={selection.toggle}
            onToggleAll={selection.toggleAll}
          />
        </>
      ) : null}
    </div>
  );
}
