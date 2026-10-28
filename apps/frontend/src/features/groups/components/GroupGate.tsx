import type { ReactNode } from "react";
import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { OrganizationGate } from "../../orgs/components/OrganizationGate";
import type { InvoicePermissions } from "../../permissions/types";
import { useGroupsQuery } from "../hooks/useGroups";
import type { Group } from "../types";

export interface GroupContext {
  organization: { id: string; name: string };
  group: Group;
  canManage: boolean;
  /** My effective flags in this group (presentation only), when I belong. */
  effective: InvoicePermissions | undefined;
  /** The group list could not be refreshed; what is shown may be stale. */
  refreshFailed: boolean;
  retry: () => void;
}

/**
 * Resolves the organization and the group of the URL for every group screen:
 * not-found for a group the person cannot see, a retry when the list fails,
 * and (with `manageOnly`) a forbidden message for plain members.
 */
export function GroupGate({
  profile,
  manageOnly = false,
  forbiddenTitle = "Grupo",
  forbiddenMessage = "Solo los administradores de la organización pueden administrar este grupo.",
  children,
}: {
  profile: Profile;
  manageOnly?: boolean;
  forbiddenTitle?: string;
  forbiddenMessage?: string;
  children: (context: GroupContext) => ReactNode;
}) {
  const { groupId = "" } = useParams();
  return (
    <OrganizationGate
      profile={profile}
      forbiddenTitle={forbiddenTitle}
      forbiddenMessage={forbiddenMessage}
    >
      {({ organization, canManage }) =>
        manageOnly && !canManage ? (
          <div className="screen-stack">
            <BackLink to={paths.group(organization.id, groupId)}>
              Grupo
            </BackLink>
            <PageHeader title={forbiddenTitle} />
            <p role="alert">{forbiddenMessage}</p>
          </div>
        ) : (
          <GroupLoader
            key={`${organization.id}:${groupId}`}
            profile={profile}
            organization={organization}
            groupId={groupId}
            canManage={canManage}
          >
            {children}
          </GroupLoader>
        )
      }
    </OrganizationGate>
  );
}

function GroupLoader({
  profile,
  organization,
  groupId,
  canManage,
  children,
}: {
  profile: Profile;
  organization: { id: string; name: string };
  groupId: string;
  canManage: boolean;
  children: (context: GroupContext) => ReactNode;
}) {
  const groups = useGroupsQuery(organization.id);
  const group = groups.data?.find(({ id }) => id === groupId);
  const back = (
    <BackLink to={paths.organizationGroups(organization.id)}>
      Grupos de {organization.name}
    </BackLink>
  );

  if (group) {
    const effective = profile.memberships
      .find(({ organization: entry }) => entry.id === organization.id)
      ?.groups.find((entry) => entry.group.id === groupId)?.effective;
    return children({
      organization,
      group,
      canManage,
      effective,
      refreshFailed: groups.isError,
      retry: () => void groups.refetch(),
    });
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
