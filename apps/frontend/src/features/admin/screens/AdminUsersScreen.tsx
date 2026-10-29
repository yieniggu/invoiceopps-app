import { Users } from "lucide-react";
import { useId } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { DataTable, type DataColumn } from "../../../components/DataTable";
import { EmptyState } from "../../../components/EmptyState";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import { PaginationControls } from "../../../components/PaginationControls";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { SearchForm } from "../../../components/SearchForm";
import { fromApiRut } from "../../../lib/rut";
import { paths } from "../../navigation/paths";
import {
  parsePage,
  useOutOfRangeRedirect,
} from "../../navigation/useListParams";
import { accountStatusLabel, activityLabel } from "../../users/presentation";
import { useAdminUsersQuery } from "../hooks/useAdminUsers";
import type { AdminUserListItem, AdminUserStatus } from "../types";

const PAGE_SIZE = 20;

const STATUS_OPTIONS: ReadonlyArray<readonly [AdminUserStatus, string]> = [
  ["all", "Todos"],
  ["active", "Activos"],
  ["disabled", "Desactivados"],
];

const parseStatus = (value: string | null): AdminUserStatus =>
  value === "active" || value === "disabled" ? value : "all";

const COLUMNS: DataColumn<AdminUserListItem>[] = [
  {
    header: "Nombre",
    cell: ({ id, name }) => <Link to={paths.adminUser(id)}>{name}</Link>,
  },
  { header: "RUT", cell: ({ rut }) => fromApiRut(rut) },
  {
    header: "Estado",
    cell: ({ disabledAt }) => accountStatusLabel(disabledAt !== null),
  },
  {
    header: "Actividad",
    cell: ({ recentlyActive }) => activityLabel(recentlyActive),
  },
];

/** Platform directory: search, status and page live in the URL. */
export function AdminUsersScreen() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const search = params.get("search") ?? "";
  const status = parseStatus(params.get("status"));
  const page = parsePage(params.get("page"));
  const users = useAdminUsersQuery({
    search,
    status,
    page,
    pageSize: PAGE_SIZE,
  });
  const statusId = useId();
  const go = (next: {
    search?: string;
    status?: AdminUserStatus;
    page?: number;
  }) => navigate(paths.adminUsers({ search, status, page, ...next }));
  const outOfRange = useOutOfRangeRedirect(
    {
      page,
      pageSize: users.data?.pageSize || PAGE_SIZE,
      total: users.data?.total,
      rowCount: users.data?.users.length ?? 0,
      settled: !!users.data && !users.isPlaceholderData,
    },
    (last) => paths.adminUsers({ search, status, page: last }),
  );

  return (
    <div className="screen-stack screen-fill">
      <PageHeader
        title="Administración"
        description="Todas las personas de la plataforma: busca, revisa su estado y abre su perfil."
        action={<LinkButton to={paths.adminNewUser}>Crear usuario</LinkButton>}
      />
      <div className="action-row">
        <SearchForm
          label="Buscar por nombre o RUT"
          initial={search}
          onSearch={(text) => go({ search: text, page: 1 })}
        />
        <label htmlFor={statusId}>Estado de la cuenta</label>
        <select
          id={statusId}
          value={status}
          onChange={(event) =>
            go({ status: event.target.value as AdminUserStatus, page: 1 })
          }
        >
          {STATUS_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <QueryFeedback
        query={users}
        loading="Cargando usuarios..."
        error="No fue posible cargar los usuarios."
        staleError="No fue posible actualizar la lista de usuarios; lo que ves puede estar desactualizado."
        retryLabel="Reintentar usuarios"
      />
      {users.data && users.data.users.length === 0 && !outOfRange ? (
        <EmptyState
          icon={Users}
          title="No hay usuarios que coincidan"
          description="Prueba con otro término de búsqueda o cambia el estado de la cuenta."
        />
      ) : null}
      {users.data && users.data.users.length > 0 ? (
        <DataTable
          label="Usuarios de la plataforma"
          rows={users.data.users}
          columns={COLUMNS}
        />
      ) : null}
      {users.data && users.data.total > 0 ? (
        <PaginationControls
          page={page}
          pageSize={users.data.pageSize || PAGE_SIZE}
          total={users.data.total}
          busy={users.isPlaceholderData}
          onPageChange={(next) => go({ page: next })}
        />
      ) : null}
    </div>
  );
}
