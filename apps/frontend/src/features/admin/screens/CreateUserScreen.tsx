import { useSearchParams } from "react-router";

import { PageHeader } from "../../../components/PageHeader";
import { useOrganizationsQuery } from "../../orgs/hooks/useOrganizations";
import { PlatformCreateUserWizard } from "../components/PlatformCreateUserWizard";

/** Platform-only: create a user with any number of organizations and groups. */
export function CreateUserScreen() {
  const organizations = useOrganizationsQuery(true);
  const [params] = useSearchParams();
  const requested = params.get("organizationId") ?? "";

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
      {organizations.data ? (
        // The wizard mounts once the list is known, so the preselected
        // organization from the URL can be validated against it. It stays
        // mounted when a later refresh fails: the draft must not be lost.
        <PlatformCreateUserWizard
          organizations={organizations.data}
          initialOrganizationId={
            organizations.data.some(({ id }) => id === requested)
              ? requested
              : undefined
          }
        />
      ) : organizations.isError ? null : (
        <p role="status">Cargando organizaciones...</p>
      )}
    </div>
  );
}
