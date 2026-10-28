import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { memberRoleLabel, isAdminRole } from "../../orgs/types/roles";
import type { ContextState } from "../../workspace/useWorkspaceGroups";
import { GroupsList } from "../components/GroupsList";

/** My groups across organizations, one section per organization. */
export function MyGroupsScreen({
  profile,
  contextState,
  onRetryContext,
}: {
  profile: Profile;
  contextState: ContextState;
  onRetryContext: () => void;
}) {
  return (
    <div className="screen-stack">
      <PageHeader
        title="Grupos"
        description="Tus grupos en cada organización y lo que permiten hacer con las facturas. Los administradores ven todos los grupos de su organización."
      />
      {contextState === "error" ? (
        <>
          <p role="alert">No fue posible validar tu espacio de trabajo.</p>
          <button type="button" onClick={onRetryContext}>
            Reintentar espacio de trabajo
          </button>
        </>
      ) : null}
      {profile.memberships.length === 0 ? (
        <p>
          No tienes organizaciones asignadas, por eso no hay grupos que mostrar.
        </p>
      ) : (
        profile.memberships.map(({ organization, role, groups }) => {
          const isAdmin = isAdminRole(role) || profile.isPlatformAdministrator;
          const titleId = `groups-${organization.id}`;
          return (
            <section key={organization.id} aria-labelledby={titleId}>
              <div className="section-heading">
                <div className="card-title-row">
                  <h2 id={titleId}>{organization.name}</h2>
                  <span className="role-badge">{memberRoleLabel(role)}</span>
                </div>
                {isAdmin ? (
                  <LinkButton
                    to={paths.newGroup(organization.id)}
                    aria-label={`Crear grupo en ${organization.name}`}
                  >
                    Crear grupo
                  </LinkButton>
                ) : null}
              </div>
              <GroupsList
                organizationId={organization.id}
                isAdmin={isAdmin}
                memberGroups={groups}
              />
            </section>
          );
        })
      )}
    </div>
  );
}
