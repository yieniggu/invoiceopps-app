import { useState } from "react";
import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { LinkButton } from "../../../components/LinkButton";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { fromApiRut } from "../../../lib/rut";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useNavigateAfter } from "../../navigation/useNavigateAfter";
import { SavedMemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import { GroupGate, type GroupContext } from "../components/GroupGate";
import { useGroupMembersQuery, useRemoveGroupMember } from "../hooks/useGroups";

/** One person of a group: their group permissions and leaving the group. */
export function GroupMemberScreen({ profile }: { profile: Profile }) {
  return (
    <GroupGate
      profile={profile}
      manageOnly
      forbiddenTitle="Miembro del grupo"
      forbiddenMessage="Solo los administradores de la organización pueden administrar a los miembros de un grupo."
    >
      {(context) => <MemberView {...context} />}
    </GroupGate>
  );
}

function MemberView({ organization, group }: GroupContext) {
  const { userId = "" } = useParams();
  const navigateAfter = useNavigateAfter();
  const members = useGroupMembersQuery(organization.id, group.id);
  const remove = useRemoveGroupMember(organization.id);
  // Kept while being removed: the refresh that follows drops the person from
  // the list before the navigation, and "not found" must not flash between.
  const [departing, setDeparting] =
    useState<NonNullable<typeof members.data>[number]>();
  const member =
    members.data?.find((entry) => entry.userId === userId) ?? departing;
  const back = (
    <BackLink to={paths.groupMembers(organization.id, group.id)}>
      Miembros del grupo
    </BackLink>
  );

  if (members.data && !member) {
    return (
      <NotFoundScreen description="No encontramos a esa persona entre los miembros del grupo." />
    );
  }
  if (!member) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader title="Miembro del grupo" />
        <QueryFeedback
          query={members}
          loading="Cargando miembro..."
          error="No fue posible cargar al miembro."
          retryLabel="Reintentar miembro"
        />
      </div>
    );
  }
  const { user } = member;

  return (
    <div className="screen-stack">
      {back}
      <PageHeader
        eyebrow={`${organization.name} · ${group.name}`}
        title={user.name}
        description={`RUT ${fromApiRut(user.rut)}`}
        action={
          <LinkButton
            to={paths.organizationMember(organization.id, user.id)}
            variant="secondary"
          >
            Ver miembro de la organización
          </LinkButton>
        }
      />
      <QueryFeedback
        query={members}
        loading=""
        error=""
        staleError="No fue posible actualizar los datos del miembro. Tus cambios ya se guardaron; no repitas la operación."
        retryLabel="Reintentar miembro"
      />
      <section aria-labelledby="group-member-permissions-title">
        <h2 id="group-member-permissions-title">Permisos en el grupo</h2>
        <SavedMemberPermissionsEditor
          memberName={user.name}
          scopeName={group.name}
          target={{
            level: "group",
            organizationId: organization.id,
            groupId: group.id,
            userId: user.id,
          }}
          saved={member.permissions}
        />
      </section>
      <section aria-labelledby="group-member-remove-title">
        <h2 id="group-member-remove-title">Quitar del grupo</h2>
        <p>La persona seguirá siendo miembro de la organización.</p>
        <div className="action-row">
          <ConfirmAction
            label={`Quitar a ${user.name} del grupo`}
            confirmLabel={`Confirmar quitar a ${user.name}`}
            disabled={remove.isPending}
            onConfirm={() => {
              setDeparting(member);
              remove.mutate(
                { groupId: group.id, userId: user.id },
                {
                  onSuccess: () =>
                    navigateAfter(
                      paths.groupMembers(organization.id, group.id),
                      {
                        state: {
                          notice: `Se quitó a ${user.name} del grupo.`,
                        },
                      },
                    ),
                  onError: () => setDeparting(undefined),
                },
              );
            }}
          />
        </div>
        <MutationFeedback
          isError={remove.isError}
          error={remove.error}
          isSuccess={false}
          success=""
          fallback="No fue posible quitar a la persona del grupo. Intenta nuevamente."
          focusOnError
        />
      </section>
    </div>
  );
}
