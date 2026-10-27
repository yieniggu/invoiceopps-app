import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useOrganizationAccess } from "../../orgs/hooks/useOrganizationAccess";
import { GroupForm } from "../components/GroupForm";
import { GroupMemberPicker } from "../components/GroupMemberPicker";
import { useCreateGroupForm } from "../hooks/useCreateGroupForm";
import type { GroupDetailState } from "./GroupDetailScreen";

export function CreateGroupScreen({ profile }: { profile: Profile }) {
  const { organizationId = "" } = useParams();
  const access = useOrganizationAccess(profile, organizationId);
  if (!access.organization) {
    return (
      <NotFoundScreen description="No encontramos esa organización entre las tuyas." />
    );
  }
  const back = (
    <BackLink to={paths.organizationGroups(organizationId)}>
      Grupos de {access.organization.name}
    </BackLink>
  );
  if (!access.isAdmin) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader
          title="Crear grupo"
          description="Solo los administradores de la organización pueden crear grupos."
        />
        <p role="alert">
          No tienes permiso para crear grupos en esta organización.
        </p>
      </div>
    );
  }
  return (
    <CreateGroupContainer organization={access.organization} back={back} />
  );
}

function CreateGroupContainer({
  organization,
  back,
}: {
  organization: { id: string; name: string };
  back: ReactNode;
}) {
  const navigate = useNavigate();
  const form = useCreateGroupForm(
    organization.id,
    ({ groupId, name, failed }) =>
      navigate(paths.group(organization.id, groupId), {
        state: {
          notice: failed
            ? `Grupo «${name}» creado, pero no se pudo completar su configuración inicial.`
            : `Grupo «${name}» creado.`,
          setup: failed,
        } satisfies GroupDetailState,
      }),
  );
  const { create, users } = form;

  return (
    <div className="screen-stack">
      {back}
      <PageHeader
        eyebrow={organization.name}
        title="Crear grupo"
        description="Define el nombre, los permisos sobre facturas y las personas que lo integran."
      />
      <GroupForm
        mode="create"
        values={form.values}
        permissions={form.permissions}
        onValuesChange={form.change}
        onPermissionsChange={form.setPermissions}
        permissionsEditable
        nameMessage={form.nameMessage}
        nameInput={form.nameInput}
        pending={create.isPending}
        submitLabel="Crear grupo"
        pendingLabel="Creando grupo..."
        onSubmit={form.submit}
        members={
          <GroupMemberPicker
            users={users.data}
            selected={form.selected}
            onToggle={form.toggleMember}
            disabled={create.isPending}
            isLoading={users.isPending}
            isError={users.isError}
            onRetry={() => void users.refetch()}
          />
        }
        feedback={
          <MutationFeedback
            isError={create.isError}
            error={create.error}
            isSuccess={false}
            success=""
            fallback="No fue posible crear el grupo. Intenta nuevamente."
          />
        }
      />
    </div>
  );
}
