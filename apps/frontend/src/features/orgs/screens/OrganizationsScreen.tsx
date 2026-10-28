import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { useRouteNotice } from "../../navigation/useRouteNotice";
import type { ContextState } from "../../workspace/useWorkspaceGroups";
import { OrganizationCard } from "../components/OrganizationCard";

/** Summary of the organizations the person belongs to. */
export function OrganizationsScreen({
  profile,
  contextState,
  onRetry,
}: {
  profile: Profile;
  contextState: ContextState;
  onRetry: () => void;
}) {
  const notice = useRouteNotice();
  const hasMemberships = profile.memberships.length > 0;

  return (
    <div className="screen-stack">
      <PageHeader
        title="Organizaciones"
        description="Las organizaciones a las que perteneces y tu rol en cada una. Abre una para ver su información y sus grupos."
        action={
          profile.isPlatformAdministrator ? (
            <LinkButton to={paths.newOrganization}>
              Crear organización
            </LinkButton>
          ) : undefined
        }
      />
      {notice ? <p role="status">{notice}</p> : null}
      {hasMemberships && contextState === "error" ? (
        <>
          <p role="alert">
            No fue posible cargar el contexto de las organizaciones.
          </p>
          <button type="button" onClick={onRetry}>
            Reintentar contexto organizacional
          </button>
        </>
      ) : null}
      {!hasMemberships ? (
        <p>
          Aún no perteneces a ninguna organización. Pide a un administrador que
          te agregue.
        </p>
      ) : (
        <ul className="card-grid">
          {profile.memberships.map(({ organization, role }) => (
            <OrganizationCard
              key={organization.id}
              organization={{ ...organization, role }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
