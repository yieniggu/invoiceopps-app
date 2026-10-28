import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { ConfirmAction } from "../../../components/ConfirmAction";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { fromApiRut } from "../../../lib/rut";
import { useIdentityId } from "../../auth/hooks/useSession";
import type { Profile } from "../../auth/types";
import { AddToGroupForm } from "../../groups/components/AddToGroupForm";
import { MemberGroupCard } from "../../groups/components/MemberGroupCard";
import { useRemoveGroupMember } from "../../groups/hooks/useGroups";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useNavigateAfter } from "../../navigation/useNavigateAfter";
import { SavedMemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import { OrganizationGate } from "../components/OrganizationGate";
import {
  useChangeRole,
  useOrgMembersQuery,
  useRefreshIdentity,
  useRemoveMember,
} from "../hooks/useOrgMembers";
import type { OrganizationMember, OrganizationRole } from "../types";
import { memberRoleLabel } from "../types/roles";

const ROLES: OrganizationRole[] = ["ADMIN", "USER"];

/** One person of the organization: role, permissions, groups and removal. */
export function OrganizationMemberScreen({ profile }: { profile: Profile }) {
  const { userId = "" } = useParams();
  return (
    <OrganizationGate
      profile={profile}
      manageOnly
      forbiddenTitle="Miembro"
      forbiddenMessage="Solo los administradores de la organización pueden administrar a sus miembros."
    >
      {({ organization }) => (
        <MemberLoader
          key={`${organization.id}:${userId}`}
          organization={organization}
          userId={userId}
        />
      )}
    </OrganizationGate>
  );
}

function MemberLoader({
  organization,
  userId,
}: {
  organization: { id: string; name: string };
  userId: string;
}) {
  const members = useOrgMembersQuery(organization.id);
  // The person being removed. The refresh that follows the removal drops them
  // from the list before the screen navigates away: keeping them here stops
  // the "not found" page from flashing in between.
  const [departing, setDeparting] = useState<OrganizationMember>();
  const member =
    members.data?.find(({ user }) => user.id === userId) ?? departing;
  const back = (
    <BackLink to={paths.organizationMembers(organization.id)}>
      Miembros
    </BackLink>
  );

  if (members.data && !member) {
    return (
      <NotFoundScreen description="No encontramos a esa persona entre los miembros de la organización." />
    );
  }
  if (!member) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader title="Miembro" />
        <QueryFeedback
          query={members}
          loading="Cargando miembro..."
          error="No fue posible cargar al miembro."
          retryLabel="Reintentar miembro"
        />
      </div>
    );
  }
  return (
    <div className="screen-stack">
      {back}
      <PageHeader
        eyebrow={organization.name}
        title={member.user.name}
        description={`RUT ${fromApiRut(member.user.rut)} · ${memberRoleLabel(member.role)}`}
      />
      <QueryFeedback
        query={members}
        loading=""
        error=""
        staleError="No fue posible actualizar los datos del miembro. Tus cambios ya se guardaron; no repitas la operación."
        retryLabel="Reintentar miembro"
      />
      <MemberDetail
        organization={organization}
        member={member}
        onDeparting={setDeparting}
      />
    </div>
  );
}

function MemberDetail({
  organization,
  member,
  onDeparting,
}: {
  organization: { id: string; name: string };
  member: OrganizationMember;
  onDeparting: (member: OrganizationMember | undefined) => void;
}) {
  const navigateAfter = useNavigateAfter();
  const refreshIdentity = useRefreshIdentity();
  // Set when you removed yourself. The profile that lost this organization is
  // refreshed only once this screen has unmounted, i.e. once the router has
  // committed the new route: a router update is a transition and a profile
  // update is not, so refreshing right after `navigate` can render the old
  // route against the new profile ("not found") for a moment.
  const leftOrganization = useRef(false);
  useEffect(
    () => () => {
      if (leftOrganization.current) refreshIdentity();
    },
    [],
  );
  const identityId = useIdentityId();
  const changeRole = useChangeRole(organization.id);
  const remove = useRemoveMember(organization.id);
  const removeFromGroup = useRemoveGroupMember(organization.id);
  const { user } = member;
  const isSelf = user.id === identityId;
  // Changing your own role can lock you out of this very screen: it asks first.
  const [pendingRole, setPendingRole] = useState<OrganizationRole>();
  // Focus goes to the confirm button when the question appears and back to
  // the role select once it is answered (and the select is enabled again).
  const roleSelect = useRef<HTMLSelectElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && !pendingRole && !changeRole.isPending) {
      restoreFocus.current = false;
      roleSelect.current?.focus();
    }
  }, [pendingRole, changeRole.isPending]);
  // Outcome of leaving a group. It lives here, not in the group card, because
  // the card disappears with the membership and would take the message along.
  const [groupStatus, setGroupStatus] = useState("");

  return (
    <>
      <section aria-labelledby="member-role-title">
        <h2 id="member-role-title">Rol en la organización</h2>
        <label>
          Rol de {user.name}
          <select
            ref={roleSelect}
            value={member.role}
            disabled={changeRole.isPending}
            onChange={(event) => {
              // The select stays controlled by the server value until the
              // refetch confirms the change.
              const role = event.target.value as OrganizationRole;
              if (isSelf) setPendingRole(role);
              else changeRole.mutate({ userId: user.id, role });
            }}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {memberRoleLabel(role)}
              </option>
            ))}
          </select>
        </label>
        {pendingRole ? (
          <div role="alert" className="screen-stack">
            <p>
              Vas a cambiar tu propio rol a {memberRoleLabel(pendingRole)}.
              {pendingRole === "USER"
                ? " Dejarás de administrar esta organización y no podrás volver a ver esta pantalla."
                : ""}
            </p>
            <div className="action-row">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  restoreFocus.current = true;
                  changeRole.mutate({ userId: user.id, role: pendingRole });
                  setPendingRole(undefined);
                }}
              >
                Confirmar cambio de rol
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  restoreFocus.current = true;
                  setPendingRole(undefined);
                }}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : null}
        <MutationFeedback
          isError={changeRole.isError}
          error={changeRole.error}
          isSuccess={changeRole.isSuccess}
          success="Rol actualizado."
          fallback="No fue posible cambiar el rol. Intenta nuevamente."
        />
      </section>
      <section aria-labelledby="member-permissions-title">
        <h2 id="member-permissions-title">Permisos en la organización</h2>
        <SavedMemberPermissionsEditor
          memberName={user.name}
          scopeName={organization.name}
          target={{
            level: "organization",
            organizationId: organization.id,
            userId: user.id,
          }}
          saved={member.permissions}
        />
      </section>
      <section aria-labelledby="member-groups-title">
        <h2 id="member-groups-title">Grupos</h2>
        {member.groups.length === 0 ? (
          <p>Esta persona no pertenece a ningún grupo de la organización.</p>
        ) : (
          <div className="screen-stack">
            {member.groups.map((group) => (
              <MemberGroupCard
                key={group.groupId}
                organizationId={organization.id}
                group={group}
                userId={user.id}
                userName={user.name}
                remove={removeFromGroup}
                onRemoved={setGroupStatus}
              />
            ))}
          </div>
        )}
        {/* Always mounted, so the announcement survives the card it is about. */}
        <p role="status" aria-live="polite">
          {groupStatus}
        </p>
        <AddToGroupForm
          organizationId={organization.id}
          userId={user.id}
          userName={user.name}
          currentGroupIds={member.groups.map(({ groupId }) => groupId)}
        />
      </section>
      <section aria-labelledby="member-remove-title">
        <h2 id="member-remove-title">Quitar de la organización</h2>
        <p>
          {isSelf
            ? "Eres tú: si te quitas, perderás el acceso a esta organización. "
            : ""}
          Al quitar a la persona también se eliminan sus membresías en los
          grupos de esta organización.
        </p>
        <div className="action-row">
          <ConfirmAction
            label={`Quitar a ${user.name} de la organización`}
            confirmLabel={`Confirmar quitar a ${user.name}`}
            disabled={remove.isPending}
            onConfirm={() => {
              onDeparting(member);
              remove.mutate(
                { userId: user.id },
                {
                  // After removing yourself the organization is no longer
                  // yours: go to your organizations, not to its member list,
                  // and only then refresh the profile that lost it.
                  onSuccess: () => {
                    if (isSelf) {
                      // Whether or not the person is still here: the profile
                      // refreshes when this screen unmounts.
                      leftOrganization.current = true;
                      navigateAfter(paths.organizations, {
                        state: {
                          notice: `Saliste de la organización «${organization.name}».`,
                        },
                      });
                    } else
                      navigateAfter(
                        paths.organizationMembers(organization.id),
                        {
                          state: {
                            notice: `Se quitó a ${user.name} de la organización.`,
                          },
                        },
                      );
                  },
                  onError: () => onDeparting(undefined),
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
          fallback="No fue posible quitar al miembro. Intenta nuevamente."
          focusOnError
        />
      </section>
    </>
  );
}
