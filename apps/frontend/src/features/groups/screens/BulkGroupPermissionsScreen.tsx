import type { Profile } from "../../auth/types";
import { BulkPermissionsView } from "../../members/BulkPermissionsView";
import { paths } from "../../navigation/paths";
import { useBulkSavePermissions } from "../../permissions/hooks/useSavePermissions";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersQuery } from "../hooks/useGroups";

/** Group-level permissions of the members chosen in the list (?userIds=). */
export function BulkGroupPermissionsScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate
      profile={profile}
      manageOnly
      forbiddenTitle="Editar permisos en bloque"
      forbiddenMessage="Solo los administradores de la organización pueden editar permisos."
    >
      {(context) => <BulkView {...context} />}
    </GroupGate>
  );
}

function BulkView({ organization, group }: GroupContext) {
  const members = useGroupMembersQuery(organization.id, group.id);
  const save = useBulkSavePermissions({
    level: "group",
    organizationId: organization.id,
    groupId: group.id,
  });

  return (
    <BulkPermissionsView
      level="group"
      scopeName={group.name}
      eyebrow={`${organization.name} · ${group.name}`}
      backTo={paths.groupMembers(organization.id, group.id)}
      backLabel="Miembros del grupo"
      description="Define los permisos sobre facturas en el grupo y aplícalos de una vez a las personas seleccionadas. Se reemplazan los cuatro permisos de cada una."
      query={members}
      people={members.data?.map(({ user, permissions }) => ({
        id: user.id,
        name: user.name,
        permissions,
      }))}
      save={save}
      messages={{
        loading: "Cargando miembros del grupo...",
        error: "No fue posible cargar los miembros del grupo.",
        retryLabel: "Reintentar miembros del grupo",
      }}
      noneFoundMessage="Ninguna de las personas seleccionadas pertenece al grupo."
      successNotice={(count) =>
        count === 1
          ? "Permisos actualizados para 1 miembro."
          : `Permisos actualizados para ${count} miembros.`
      }
    />
  );
}
