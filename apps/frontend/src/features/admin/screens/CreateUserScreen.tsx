import { useSearchParams } from "react-router";

import { PageHeader } from "../../../components/PageHeader";
import { MAX_PAGE_SIZE } from "../../../lib/pagination";
import {
  useOrganizationQuery,
  useOrganizationsPageQuery,
} from "../../orgs/hooks/useOrganizations";
import { PlatformCreateUserWizard } from "../components/PlatformCreateUserWizard";

/** Platform-only: create a user with any number of organizations and groups. */
export function CreateUserScreen() {
  // The first page of organizations is preloaded; the wizard's picker searches
  // the server for the rest, so any organization can be chosen.
  const organizations = useOrganizationsPageQuery(
    { search: "", page: 1, pageSize: MAX_PAGE_SIZE },
    true,
  );
  const [params] = useSearchParams();
  const requested = params.get("organizationId") ?? "";
  const firstPage = organizations.data?.organizations;
  const inFirstPage = firstPage?.some(({ id }) => id === requested) ?? false;
  // A requested organization beyond the first page is looked up by id.
  const lookup = useOrganizationQuery(
    requested,
    requested !== "" &&
      organizations.data !== undefined &&
      !inFirstPage &&
      organizations.data.total > organizations.data.organizations.length,
  );
  const looked = lookup.data?.organization;
  // Only the first load holds the wizard back: a later refetch of the lookup
  // must never unmount it (the draft would be lost).
  const lookingUp = lookup.isPending && lookup.fetchStatus !== "idle";

  return (
    <div className="screen-stack">
      <PageHeader
        title="Crear usuario"
        description="Registra a una persona, asígnale organizaciones y grupos con sus permisos, y entrega su contraseña temporal."
      />
      {organizations.isError ? (
        <>
          <p role="alert">
            {organizations.data
              ? "No fue posible actualizar las organizaciones; lo que ves puede estar desactualizado. Tus datos siguen aquí."
              : "No fue posible cargar las organizaciones."}
          </p>
          <button type="button" onClick={() => void organizations.refetch()}>
            Reintentar organizaciones
          </button>
        </>
      ) : null}
      {organizations.data && !lookingUp ? (
        // The wizard mounts once the list is known, so the preselected
        // organization from the URL can be validated against it. It stays
        // mounted when a later refresh fails: the draft must not be lost.
        <PlatformCreateUserWizard
          organizations={organizations.data.organizations}
          organizationsTotal={organizations.data.total}
          initialOrganizationId={
            inFirstPage ? requested : looked ? looked.id : undefined
          }
          initialOrganization={looked}
        />
      ) : organizations.isError ? null : (
        <p role="status">Cargando organizaciones...</p>
      )}
    </div>
  );
}
