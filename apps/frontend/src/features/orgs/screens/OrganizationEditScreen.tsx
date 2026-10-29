import { useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { Profile } from "../../auth/types";
import { paths, type RouteNotice } from "../../navigation/paths";
import { OrganizationForm } from "../components/OrganizationForm";
import { OrganizationGate } from "../components/OrganizationGate";
import { useEditOrganizationForm } from "../hooks/useEditOrganizationForm";
import { useOrganizationQuery } from "../hooks/useOrganizations";

/** Name and description of an organization (ADMIN or platform administrator). */
export function OrganizationEditScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Editar organización"
      forbiddenMessage="Solo los administradores de la organización pueden editarla."
    >
      {({ organization }) => (
        <EditLoader key={organization.id} organizationId={organization.id} />
      )}
    </OrganizationGate>
  );
}

function EditLoader({ organizationId }: { organizationId: string }) {
  const query = useOrganizationQuery(organizationId);
  const back = (
    <BackLink to={paths.organization(organizationId)}>Organización</BackLink>
  );
  if (!query.data) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader title="Editar organización" />
        <QueryFeedback
          query={query}
          loading="Cargando organización..."
          error="No fue posible cargar la organización."
          retryLabel="Reintentar organización"
        />
      </div>
    );
  }
  // The draft starts from the loaded data; the key restarts it per organization.
  return (
    <EditView key={organizationId} organization={query.data.organization} />
  );
}

function EditView({
  organization,
}: {
  organization: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  };
}) {
  const navigate = useNavigate();
  const form = useEditOrganizationForm(organization, (changed) =>
    navigate(paths.organization(organization.id), {
      state: changed
        ? ({ notice: "Organización actualizada." } satisfies RouteNotice)
        : undefined,
    }),
  );
  const { update } = form;

  return (
    <div className="screen-stack">
      <BackLink to={paths.organization(organization.id)}>
        {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Editar organización"
        description="Cambia el nombre y la descripción. El identificador no se puede modificar."
      />
      <OrganizationForm
        mode="edit"
        values={form.values}
        onChange={form.change}
        invalid={form.invalid}
        nameMessage={form.nameMessage}
        pending={update.isPending}
        nameInput={form.nameInput}
        onSubmit={form.submit}
      >
        <button type="submit" disabled={update.isPending}>
          {update.isPending ? "Guardando..." : "Guardar cambios"}
        </button>
        <MutationFeedback
          isError={update.isError}
          error={update.error}
          isSuccess={false}
          success=""
          fallback="No fue posible guardar los cambios. Intenta nuevamente."
        />
      </OrganizationForm>
    </div>
  );
}
