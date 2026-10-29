import { Building2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router";

import { EmptyState } from "../../../components/EmptyState";
import { PaginationControls } from "../../../components/PaginationControls";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { SearchForm } from "../../../components/SearchForm";
import { paths } from "../../navigation/paths";
import {
  parsePage,
  useOutOfRangeRedirect,
} from "../../navigation/useListParams";
import { useOrganizationsPageQuery } from "../hooks/useOrganizations";
import type { Profile } from "../../auth/types";
import { OrganizationCard } from "./OrganizationCard";

const PAGE_SIZE = 20;

/** Every organization of the platform, paginated; search and page in the URL. */
export function OrganizationDirectory({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const search = params.get("search") ?? "";
  const page = parsePage(params.get("page"));
  const organizations = useOrganizationsPageQuery(
    { search, page, pageSize: PAGE_SIZE },
    true,
  );
  const go = (next: { search?: string; page?: number }) =>
    navigate(paths.organizationsPage({ search, page, ...next }));
  const outOfRange = useOutOfRangeRedirect(
    {
      page,
      pageSize: organizations.data?.pageSize || PAGE_SIZE,
      total: organizations.data?.total,
      rowCount: organizations.data?.organizations.length ?? 0,
      settled: !!organizations.data && !organizations.isPlaceholderData,
    },
    (last) => paths.organizationsPage({ search, page: last }),
  );

  return (
    <>
      <SearchForm
        label="Buscar organización"
        initial={search}
        onSearch={(text) => go({ search: text, page: 1 })}
      />
      <QueryFeedback
        query={organizations}
        loading="Cargando organizaciones..."
        error="No fue posible cargar las organizaciones."
        staleError="No fue posible actualizar las organizaciones; lo que ves puede estar desactualizado."
        retryLabel="Reintentar organizaciones"
      />
      {organizations.data &&
      organizations.data.organizations.length === 0 &&
      !outOfRange ? (
        search ? (
          <EmptyState
            icon={Building2}
            title="No hay organizaciones que coincidan"
            description="Prueba con otro término de búsqueda."
          />
        ) : (
          <EmptyState
            icon={Building2}
            title="Aún no hay organizaciones"
            description="Crea la primera para empezar a gestionar miembros y grupos."
          />
        )
      ) : null}
      {organizations.data && organizations.data.organizations.length > 0 ? (
        <ul className="card-grid" aria-label="Organizaciones de la plataforma">
          {organizations.data.organizations.map((organization) => (
            <OrganizationCard
              key={organization.id}
              organization={{
                ...organization,
                // Only the organizations I belong to show my role.
                role: profile.memberships.find(
                  (entry) => entry.organization.id === organization.id,
                )?.role,
              }}
            />
          ))}
        </ul>
      ) : null}
      {organizations.data && organizations.data.total > 0 ? (
        <PaginationControls
          page={page}
          pageSize={organizations.data.pageSize || PAGE_SIZE}
          total={organizations.data.total}
          busy={organizations.isPlaceholderData}
          onPageChange={(next) => go({ page: next })}
        />
      ) : null}
    </>
  );
}
