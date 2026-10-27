import type { ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useOrganizationAccess } from "../../orgs/hooks/useOrganizationAccess";
import type { GroupSetup } from "../api/groupSetup";
import { GroupForm } from "../components/GroupForm";
import { GroupMembersPanel } from "../components/GroupMembersPanel";
import { GroupSetupRetry } from "../components/GroupSetupRetry";
import { useGroupPermissionsDraft } from "../hooks/useGroupPermissionsDraft";
import { useGroupsQuery } from "../hooks/useGroups";
import type { Group } from "../types";

/** Navigation state handed over by the create flow. */
export interface GroupDetailState {
  notice?: string;
  setup?: GroupSetup;
}

export function GroupDetailScreen({ profile }: { profile: Profile }) {
  const { organizationId = "", groupId = "" } = useParams();
  const access = useOrganizationAccess(profile, organizationId);
  if (!access.organization) {
    return (
      <NotFoundScreen description="No encontramos esa organización entre las tuyas." />
    );
  }
  return (
    <GroupDetailLoader
      organization={access.organization}
      groupId={groupId}
      isAdmin={access.isAdmin}
    />
  );
}

function GroupDetailLoader({
  organization,
  groupId,
  isAdmin,
}: {
  organization: { id: string; name: string };
  groupId: string;
  isAdmin: boolean;
}) {
  const groups = useGroupsQuery(organization.id);
  const group = groups.data?.find(({ id }) => id === groupId);
  const back = (
    <BackLink to={paths.organizationGroups(organization.id)}>
      Grupos de {organization.name}
    </BackLink>
  );

  if (group) {
    return (
      <GroupDetail
        organization={organization}
        group={group}
        isAdmin={isAdmin}
        back={back}
        refreshFailed={groups.isError}
        onRetry={() => void groups.refetch()}
      />
    );
  }
  if (groups.data) {
    return (
      <NotFoundScreen description="No encontramos ese grupo entre los que puedes ver." />
    );
  }
  if (groups.isError) {
    return (
      <div className="screen-stack">
        {back}
        <PageHeader title="Grupo" />
        <p role="alert">No fue posible cargar el grupo.</p>
        <button type="button" onClick={() => void groups.refetch()}>
          Reintentar grupos
        </button>
      </div>
    );
  }
  return (
    <div className="screen-stack">
      {back}
      <PageHeader title="Grupo" />
      <p role="status">Cargando grupo...</p>
    </div>
  );
}

function GroupDetail({
  organization,
  group,
  isAdmin,
  back,
  refreshFailed,
  onRetry,
}: {
  organization: { id: string; name: string };
  group: Group;
  isAdmin: boolean;
  back: ReactNode;
  /** The group list could not be refreshed; what is shown may be stale. */
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state as GroupDetailState | null) ?? {};
  const { update, permissions, setDraft, save } = useGroupPermissionsDraft(
    organization.id,
    group,
  );
  // The pending setup lives in the history entry, so a reload keeps it.
  const setSetup = (setup: GroupSetup | undefined) =>
    navigate(location.pathname, {
      replace: true,
      state: { ...state, setup },
    });

  return (
    <div className="screen-stack">
      {back}
      <PageHeader
        eyebrow={organization.name}
        title={group.name}
        description={
          isAdmin
            ? "Define qué pueden hacer con las facturas las personas del grupo y quiénes lo integran."
            : "Estos son los permisos sobre facturas que tienes por pertenecer a este grupo."
        }
      />
      {state.notice ? <p role="status">{state.notice}</p> : null}
      {refreshFailed ? (
        <>
          <p role="alert">
            No fue posible actualizar la lista de grupos. Tus cambios ya se
            guardaron; no repitas la operación.
          </p>
          <button type="button" onClick={onRetry}>
            Reintentar grupos
          </button>
        </>
      ) : null}
      {isAdmin && state.setup ? (
        <GroupSetupRetry
          organizationId={organization.id}
          groupId={group.id}
          setup={state.setup}
          onChange={setSetup}
        />
      ) : null}
      <GroupForm
        mode="view"
        values={{ name: group.name, description: group.description ?? "" }}
        permissions={permissions}
        onPermissionsChange={setDraft}
        permissionsEditable={isAdmin}
        pending={update.isPending}
        submitLabel={isAdmin ? "Guardar permisos" : undefined}
        pendingLabel="Guardando permisos..."
        onSubmit={(event) => {
          event.preventDefault();
          if (isAdmin) save();
        }}
        feedback={
          <MutationFeedback
            isError={update.isError}
            error={update.error}
            isSuccess={update.isSuccess}
            success="Permisos guardados."
            fallback="No fue posible guardar los permisos. Intenta nuevamente."
          />
        }
      />
      {isAdmin ? (
        <GroupMembersPanel organizationId={organization.id} group={group} />
      ) : null}
    </div>
  );
}
