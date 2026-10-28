import type { Profile } from "../../auth/types";
import { BulkPermissionsView } from "../../members/BulkPermissionsView";
import { paths } from "../../navigation/paths";
import { useBulkSavePermissions } from "../../permissions/hooks/useSavePermissions";
import { OrganizationGate } from "../components/OrganizationGate";
import { useOrgMembersQuery } from "../hooks/useOrgMembers";

/** Organization-level permissions of the members chosen in the list (?userIds=). */
export function BulkOrganizationPermissionsScreen({
  profile,
}: {
  profile: Profile;
}) {
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Editar permisos en bloque"
      forbiddenMessage="Solo los administradores de la organización pueden editar permisos."
    >
      {({ organization }) => (
        <BulkView key={organization.id} organization={organization} />
      )}
    </OrganizationGate>
  );
}

function BulkView({
  organization,
}: {
  organization: { id: string; name: string };
}) {
  const members = useOrgMembersQuery(organization.id);
  const save = useBulkSavePermissions({
    level: "organization",
    organizationId: organization.id,
  });

  return (
    <BulkPermissionsView
      level="organization"
      scopeName={organization.name}
      eyebrow={organization.name}
      backTo={paths.organizationMembers(organization.id)}
      backLabel="Miembros"
      description="Define los permisos sobre facturas en la organización y aplícalos de una vez a las personas seleccionadas. Se reemplazan los cuatro permisos de cada una."
      query={members}
      people={members.data?.map(({ user, permissions }) => ({
        id: user.id,
        name: user.name,
        permissions,
      }))}
      save={save}
      messages={{
        loading: "Cargando miembros...",
        error: "No fue posible cargar los miembros.",
        retryLabel: "Reintentar miembros",
      }}
      noneFoundMessage="Ninguna de las personas seleccionadas pertenece a la organización."
      successNotice={(count) =>
        count === 1
          ? "Permisos actualizados para 1 miembro."
          : `Permisos actualizados para ${count} miembros.`
      }
    />
  );
}
