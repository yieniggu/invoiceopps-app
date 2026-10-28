import { Link } from "react-router";

import { LinkButton } from "../../../components/LinkButton";
import type { SelectionColumn } from "../../../components/SelectionTable";
import { fromApiRut } from "../../../lib/rut";
import type { Profile } from "../../auth/types";
import {
  MembersTableScreen,
  type MemberRow,
} from "../../members/MembersTableScreen";
import { paths } from "../../navigation/paths";
import { permissionRatio } from "../../permissions/types";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersQuery } from "../hooks/useGroups";
import type { GroupMember } from "../types";

/** People of a group, with selection for bulk permission edits. */
export function GroupMembersScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate
      profile={profile}
      manageOnly
      forbiddenTitle="Miembros del grupo"
      forbiddenMessage="Solo los administradores de la organización pueden ver a los miembros de un grupo."
    >
      {(context) => <MembersView {...context} />}
    </GroupGate>
  );
}

function MembersView({ organization, group }: GroupContext) {
  const members = useGroupMembersQuery(organization.id, group.id);

  const columns: SelectionColumn<MemberRow<GroupMember>>[] = [
    {
      header: "Nombre",
      cell: ({ user }) => (
        <Link to={paths.groupMember(organization.id, group.id, user.id)}>
          {user.name}
        </Link>
      ),
    },
    { header: "RUT", cell: ({ user }) => fromApiRut(user.rut) },
    {
      header: "Permisos",
      cell: ({ permissions }) => `${permissionRatio(permissions)} permisos`,
    },
  ];

  return (
    <MembersTableScreen
      query={members}
      backTo={paths.group(organization.id, group.id)}
      backLabel={group.name}
      eyebrow={`${organization.name} · ${group.name}`}
      title="Miembros del grupo"
      description="Las personas del grupo y cuántos permisos sobre facturas tienen en él."
      action={
        <LinkButton to={paths.newGroupMembers(organization.id, group.id)}>
          Agregar miembros
        </LinkButton>
      }
      messages={{
        loading: "Cargando miembros del grupo...",
        error: "No fue posible cargar los miembros del grupo.",
        staleError:
          "No fue posible actualizar los miembros del grupo. Tus cambios ya se guardaron; no repitas la operación.",
        retryLabel: "Reintentar miembros del grupo",
        empty:
          "Este grupo no tiene miembros. Agrégalos con «Agregar miembros».",
      }}
      tableLabel="Miembros del grupo"
      columns={columns}
      bulkPath={(userIds) =>
        paths.bulkGroupPermissions(organization.id, group.id, userIds)
      }
    />
  );
}
