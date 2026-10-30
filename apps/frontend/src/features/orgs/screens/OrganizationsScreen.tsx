import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { Toast } from "../../../components/Toast";
import { useRouteNotice } from "../../navigation/useRouteNotice";
import type { ContextState } from "../../workspace/useWorkspaceGroups";
import { OrganizationCard } from "../components/OrganizationCard";
import { OrganizationDirectory } from "../components/OrganizationDirectory";

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
    <div
      className={`screen-stack${profile.isPlatformAdministrator ? " screen-fill" : ""}`}
    >
      <PageHeader
        title="Organizaciones"
        description={
          profile.isPlatformAdministrator
            ? "Todas las organizaciones de la plataforma. Busca una y ábrela para administrarla."
            : "Las organizaciones a las que perteneces y tu rol en cada una. Abre una para ver su información y sus grupos."
        }
        action={
          profile.isPlatformAdministrator ? (
            <LinkButton to={paths.newOrganization}>
              Crear organización
            </LinkButton>
          ) : undefined
        }
      />
      <Toast message={notice.message} noticeId={notice.id} />
      {profile.isPlatformAdministrator ? (
        <OrganizationDirectory profile={profile} />
      ) : null}
      {!profile.isPlatformAdministrator &&
      hasMemberships &&
      contextState === "error" ? (
        <>
          <p role="alert">No fue posible cargar tus organizaciones.</p>
          <button type="button" onClick={onRetry}>
            Reintentar
          </button>
        </>
      ) : null}
      {profile.isPlatformAdministrator ? null : !hasMemberships ? (
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
