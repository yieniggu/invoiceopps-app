import { useNavigate } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { useRouteNotice } from "../../navigation/useRouteNotice";
import { useOrgUsersQuery } from "../../users/hooks/useUsers";
import { AddMembersForm } from "../components/AddMembersForm";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersQuery } from "../hooks/useGroups";

/** Adds several organization members to a group, each with their permissions. */
export function AddGroupMembersScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate
      profile={profile}
      manageOnly
      forbiddenTitle="Agregar miembros al grupo"
      forbiddenMessage="Solo los administradores de la organización pueden agregar miembros a un grupo."
    >
      {(context) => <AddMembersView {...context} />}
    </GroupGate>
  );
}

function AddMembersView({ organization, group }: GroupContext) {
  const navigate = useNavigate();
  const notice = useRouteNotice();
  const users = useOrgUsersQuery(organization.id);
  const members = useGroupMembersQuery(organization.id, group.id);
  const memberIds = new Set((members.data ?? []).map(({ userId }) => userId));
  const candidates = (users.data ?? []).filter(({ id }) => !memberIds.has(id));

  return (
    <div className="screen-stack">
      <BackLink to={paths.groupMembers(organization.id, group.id)}>
        Miembros del grupo
      </BackLink>
      <PageHeader
        eyebrow={`${organization.name} · ${group.name}`}
        title="Agregar miembros al grupo"
        description="Elige a las personas de la organización que se suman al grupo y define los permisos sobre facturas de cada una."
      />
      {notice ? <p role="status">{notice}</p> : null}
      <QueryFeedback
        query={users}
        loading="Cargando personas de la organización..."
        error="No fue posible cargar las personas de la organización."
        retryLabel="Reintentar personas"
      />
      <QueryFeedback
        query={members}
        loading="Cargando miembros del grupo..."
        error="No fue posible cargar los miembros del grupo."
        retryLabel="Reintentar miembros del grupo"
      />
      {users.data && members.data ? (
        <AddMembersForm
          organizationId={organization.id}
          groupId={group.id}
          candidates={candidates}
          onAdded={(count) =>
            navigate(paths.groupMembers(organization.id, group.id), {
              state: {
                notice:
                  count === 1
                    ? "1 persona agregada al grupo."
                    : `${count} personas agregadas al grupo.`,
              },
            })
          }
        />
      ) : null}
    </div>
  );
}
