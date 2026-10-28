import { useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { OrganizationGate } from "../../orgs/components/OrganizationGate";
import { GroupForm } from "../components/GroupForm";
import { useCreateGroupForm } from "../hooks/useCreateGroupForm";

export function CreateGroupScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Crear grupo"
      forbiddenMessage="No tienes permiso para crear grupos en esta organización."
    >
      {({ organization }) => (
        <CreateGroupContainer
          key={organization.id}
          organization={organization}
        />
      )}
    </OrganizationGate>
  );
}

function CreateGroupContainer({
  organization,
}: {
  organization: { id: string; name: string };
}) {
  const navigate = useNavigate();
  const form = useCreateGroupForm(organization.id, (groupId) =>
    navigate(paths.newGroupMembers(organization.id, groupId), {
      state: { notice: "Grupo creado. Agrega a sus miembros." },
    }),
  );

  return (
    <div className="screen-stack">
      <BackLink to={paths.organizationGroups(organization.id)}>
        Grupos de {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Crear grupo"
        description="Define el nombre del grupo. En el siguiente paso agregarás a sus miembros y sus permisos."
      />
      <GroupForm
        values={form.values}
        onValuesChange={form.change}
        nameMessage={form.nameMessage}
        nameInput={form.nameInput}
        pending={form.create.isPending}
        onSubmit={form.submit}
        feedback={
          <MutationFeedback
            isError={form.create.isError}
            error={form.create.error}
            isSuccess={false}
            success=""
            fallback="No fue posible crear el grupo. Intenta nuevamente."
          />
        }
      />
    </div>
  );
}
