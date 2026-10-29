import type { ReactNode } from "react";
import { useNavigate } from "react-router";

import { BackLink } from "../../components/BackLink";
import { PageHeader } from "../../components/PageHeader";
import { PaginationControls } from "../../components/PaginationControls";
import { QueryFeedback } from "../../components/QueryFeedback";
import {
  SelectionTable,
  type SelectionColumn,
} from "../../components/SelectionTable";
import { useIdSelection } from "../../hooks/useIdSelection";
import { MAX_BULK_MEMBERS } from "../../lib/limits";
import { Toast } from "../../components/Toast";
import { pageSearch, useOutOfRangeRedirect } from "../navigation/useListParams";
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
 * the columns and the labels they pass in. A paginated list passes
 * `pagination`; the selection then applies to the rows of the current page.
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
  pagination,
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
  /** Paginated lists: the selection and the bulk action stay on this page. */
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    busy?: boolean;
    onPageChange: (page: number) => void;
  };
}) {
  const navigate = useNavigate();
  const notice = useRouteNotice();
  const rows: MemberRow<Member>[] = (query.data ?? []).map((member) => ({
    ...member,
    id: member.user.id,
    name: member.user.name,
  }));
  // A selection belongs to its page: changing page starts it over.
  const selection = useIdSelection(
    rows.map(({ id }) => id),
    pagination?.page,
  );
  const count = selection.selected.length;
  const outOfRange = useOutOfRangeRedirect(
    {
      page: pagination?.page ?? 1,
      pageSize: pagination?.pageSize ?? 1,
      total: pagination?.total,
      rowCount: rows.length,
      settled: !!query.data && !!pagination && !pagination.busy,
    },
    pageSearch,
  );
  const scopeNote = pagination ? " en esta página" : "";

  return (
    <div className="screen-stack">
      <BackLink to={backTo}>{backLabel}</BackLink>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        action={action}
      />
      <Toast message={notice.message} noticeId={notice.id} />
      <QueryFeedback
        query={query}
        loading={messages.loading}
        error={messages.error}
        staleError={messages.staleError}
        retryLabel={messages.retryLabel}
      />
      {query.data && rows.length === 0 && !outOfRange ? (
        <p>{messages.empty}</p>
      ) : null}
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
                    ? `1 persona seleccionada${scopeNote}.`
                    : `${count} personas seleccionadas${scopeNote}.`}
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
            selectAllLabel={`Seleccionar todos${scopeNote}`}
          />
        </>
      ) : null}
      {pagination ? <PaginationControls {...pagination} /> : null}
    </div>
  );
}
