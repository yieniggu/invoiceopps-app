import { Link, useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import { Tabs } from "../../../components/Tabs";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { ProvisionUserForm } from "../../users/components/ProvisionUserForm";
import { AssignMemberForm } from "../components/AssignMemberForm";
import { OrganizationGate } from "../components/OrganizationGate";

/** Two ways to add a person: an existing one by RUT, or a brand new user. */
export function AddOrganizationMemberScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Agregar miembro"
      forbiddenMessage="Solo los administradores de la organización pueden agregar miembros."
    >
      {({ organization }) => (
        <AddMemberView
          // Keyed so a form never carries values into another organization.
          key={organization.id}
          organization={organization}
          isPlatformAdministrator={profile.isPlatformAdministrator}
        />
      )}
    </OrganizationGate>
  );
}

function AddMemberView({
  organization,
  isPlatformAdministrator,
}: {
  organization: { id: string; name: string };
  isPlatformAdministrator: boolean;
}) {
  const navigate = useNavigate();
  const toMembers = (notice: string) =>
    navigate(paths.organizationMembers(organization.id), {
      state: { notice },
    });

  return (
    <div className="screen-stack">
      <BackLink to={paths.organizationMembers(organization.id)}>
        Miembros
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Agregar miembro"
        description="Suma a la organización a una persona que ya existe en la plataforma, o crea un usuario nuevo."
      />
      <Tabs
        label="Cómo agregar a la persona"
        tabs={[
          {
            id: "existing",
            label: "Agregar persona existente",
            panel: (
              <AssignMemberForm
                organizationId={organization.id}
                onAssigned={() =>
                  toMembers("Persona agregada a la organización.")
                }
              />
            ),
          },
          {
            id: "new",
            label: "Crear persona nueva",
            panel: (
              <>
                <ProvisionUserForm
                  organization={organization}
                  onCreated={(name) =>
                    toMembers(
                      `Usuario «${name}» creado y agregado a la organización. La persona deberá cambiar su contraseña temporal al iniciar sesión.`,
                    )
                  }
                />
                {isPlatformAdministrator ? (
                  <p>
                    <Link
                      className="text-link"
                      to={paths.adminNewUserIn(organization.id)}
                    >
                      ¿Debe pertenecer a varias organizaciones o grupos a la
                      vez? Usa el asistente de administración{" "}
                      <span aria-hidden="true">→</span>
                    </Link>
                  </p>
                ) : null}
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
