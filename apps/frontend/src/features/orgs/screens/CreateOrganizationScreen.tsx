import { useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths, type RouteNotice } from "../../navigation/paths";
import { OrganizationForm } from "../components/OrganizationForm";
import { useCreateOrganizationForm } from "../hooks/useCreateOrganizationForm";

const BACK = <BackLink to={paths.organizations}>Organizaciones</BackLink>;

/** Platform administrator only: the API rejects everyone else with 403. */
export function CreateOrganizationScreen({ profile }: { profile: Profile }) {
  if (!profile.isPlatformAdministrator) {
    return (
      <div className="screen-stack">
        {BACK}
        <PageHeader
          title="Crear organización"
          description="Solo la administración de la plataforma puede crear organizaciones."
        />
        <p role="alert">
          No tienes permiso para crear organizaciones. Si necesitas una nueva,
          pídesela a la administración de la plataforma.
        </p>
      </div>
    );
  }
  return <CreateOrganizationContainer />;
}

function CreateOrganizationContainer() {
  const navigate = useNavigate();
  const form = useCreateOrganizationForm((name) =>
    navigate(paths.organizations, {
      state: {
        notice: `Organización «${name}» creada. Aparecerá en esta lista solo si tú eres su primer administrador.`,
      } satisfies RouteNotice,
    }),
  );
  const { create } = form;

  return (
    <div className="screen-stack">
      {BACK}
      <PageHeader
        title="Crear organización"
        description="Define la organización y a su primer administrador; esa persona podrá agregar al resto."
      />
      <OrganizationForm
        mode="create"
        values={form.values}
        onChange={form.change}
        invalid={form.invalid}
        nameMessage={form.nameMessage}
        slugMessage={form.slugMessage}
        pending={create.isPending}
        submitted={form.submitted}
        nameInput={form.refs.nameInput}
        slugInput={form.refs.slugInput}
        rutInput={form.refs.rutInput}
        onSubmit={form.submit}
      >
        <p className="field-hint">
          Crear una organización no otorga acceso a sus facturas ni a sus
          grupos.
        </p>
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creando organización..." : "Crear organización"}
        </button>
        <MutationFeedback
          isError={create.isError}
          error={create.error}
          isSuccess={false}
          success=""
          fallback="No fue posible crear la organización. Revisa los datos e intenta nuevamente."
        />
      </OrganizationForm>
    </div>
  );
}
