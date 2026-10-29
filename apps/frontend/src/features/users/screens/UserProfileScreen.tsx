import { Link, useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { isUuid } from "../../../lib/uuid";
import { isApiError } from "../../auth/api/apiError";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useUserBasicQuery } from "../hooks/useUsers";
import { activityLabel } from "../presentation";

/**
 * Basic profile of a person I share an organization with: name, contact and
 * the organizations in common. The server answers 404 for anyone else (and
 * for people that do not exist), and so does this screen. The platform
 * administrator sees every person, with all of their organizations, so the
 * copy speaks of the person's organizations instead of "shared" ones.
 */
export function UserProfileScreen({ profile }: { profile: Profile }) {
  const { userId = "" } = useParams();
  return (
    <UserProfileView
      key={userId}
      userId={userId}
      platform={profile.isPlatformAdministrator}
    />
  );
}

function UserProfileView({
  userId,
  platform,
}: {
  userId: string;
  platform: boolean;
}) {
  // A malformed id is no person: no request (the server answers 404).
  const wellFormed = isUuid(userId);
  const query = useUserBasicQuery(userId, wellFormed);

  if (
    !wellFormed ||
    (query.isError &&
      query.data === undefined &&
      isApiError(query.error) &&
      query.error.status === 404)
  )
    return (
      <NotFoundScreen
        description={
          platform
            ? "No encontramos a esa persona en la plataforma."
            : "No encontramos a esa persona entre quienes comparten organización contigo."
        }
      />
    );

  const detail = query.data;
  return (
    <div className="screen-stack">
      <BackLink to={paths.organizations}>Organizaciones</BackLink>
      <PageHeader title={detail?.user.name ?? "Persona"} />
      <QueryFeedback
        query={query}
        loading="Cargando persona..."
        error="No fue posible cargar a la persona."
        staleError="No fue posible actualizar los datos de la persona; lo que ves puede estar desactualizado."
        retryLabel="Reintentar persona"
      />
      {detail ? (
        <>
          <section aria-labelledby="user-data-title">
            <h2 id="user-data-title">Datos</h2>
            <dl className="summary-list">
              <div>
                <dt>Nombre</dt>
                <dd>{detail.user.name}</dd>
              </div>
              <div>
                <dt>Correo</dt>
                <dd>{detail.user.email ?? "Sin correo"}</dd>
              </div>
              <div>
                <dt>Actividad</dt>
                <dd>{activityLabel(detail.user.recentlyActive)}</dd>
              </div>
            </dl>
          </section>
          <section aria-labelledby="user-shared-title">
            <h2 id="user-shared-title">
              {platform ? "Organizaciones" : "Organizaciones compartidas"}
            </h2>
            {detail.sharedOrganizations.length === 0 ? (
              <p>
                {platform
                  ? "Esta persona no pertenece a ninguna organización."
                  : "No compartes organizaciones con esta persona."}
              </p>
            ) : (
              <ul>
                {detail.sharedOrganizations.map(({ id, name }) => (
                  <li key={id}>
                    <Link to={paths.organization(id)}>{name}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
