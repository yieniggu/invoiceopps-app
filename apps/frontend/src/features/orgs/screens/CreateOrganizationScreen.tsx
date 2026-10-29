import { useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { cleanRut } from "../../../lib/rut";
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
  return <CreateOrganizationContainer profile={profile} />;
}

/**
 * The platform administrator is not a member of what they create unless they
 * name themselves first administrator. The directory they land on lists every
 * organization, so the notice says where to find it and who administers it.
 */
function createdNotice(name: string, actorIsFirstAdmin: boolean) {
  return actorIsFirstAdmin
    ? `Organización «${name}» creada.`
    : `Organización «${name}» creada. Aparece en esta lista y puedes abrirla para administrarla; su primer administrador la verá en la suya y podrá agregar a las personas.`;
}

function CreateOrganizationContainer({ profile }: { profile: Profile }) {
  const navigate = useNavigate();
  const form = useCreateOrganizationForm(({ name, firstAdminRut }) =>
    navigate(paths.organizations, {
      state: {
        notice: createdNotice(
          name,
          cleanRut(firstAdminRut) === cleanRut(profile.rut),
        ),
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
