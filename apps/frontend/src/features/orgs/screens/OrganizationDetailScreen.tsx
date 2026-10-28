import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import { QueryFeedback } from "../../../components/QueryFeedback";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { OrganizationGate } from "../components/OrganizationGate";
import { useOrganizationQuery } from "../hooks/useOrganizations";

/** Summary of one organization of mine, with the way into its people and groups. */
export function OrganizationDetailScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate profile={profile}>
      {({ organization, canManage }) => (
        <OrganizationSummaryView
          key={organization.id}
          organization={organization}
          canManage={canManage}
        />
      )}
    </OrganizationGate>
  );
}

function OrganizationSummaryView({
  organization,
  canManage,
}: {
  organization: { id: string; name: string };
  canManage: boolean;
}) {
  const query = useOrganizationQuery(organization.id);
  const detail = query.data;

  return (
    <div className="screen-stack">
      <BackLink to={paths.organizations}>Organizaciones</BackLink>
      <PageHeader
        eyebrow="Organización"
        title={organization.name}
        description={
          canManage
            ? "Eres administrador: gestiona aquí a las personas y los grupos de esta organización."
            : "Eres miembro de esta organización. Aquí ves su información y tus grupos."
        }
        action={
          <div className="header-actions">
            {canManage ? (
              <LinkButton to={paths.organizationMembers(organization.id)}>
                Miembros
              </LinkButton>
            ) : null}
            <LinkButton
              to={paths.organizationGroups(organization.id)}
              variant={canManage ? "secondary" : "primary"}
            >
              Grupos
            </LinkButton>
            {canManage ? (
              <LinkButton
                to={paths.newOrganizationMember(organization.id)}
                variant="secondary"
              >
                Agregar miembro
              </LinkButton>
            ) : null}
          </div>
        }
      />
      <QueryFeedback
        query={query}
        loading="Cargando organización..."
        error="No fue posible cargar la información de la organización."
        staleError="No fue posible actualizar la información de la organización; lo que ves puede estar desactualizado."
        retryLabel="Reintentar organización"
      />
      {detail ? (
        <section aria-labelledby="organization-summary-title">
          <h2 id="organization-summary-title">Resumen</h2>
          <dl className="summary-list">
            <div>
              <dt>Nombre</dt>
              <dd>{detail.organization.name}</dd>
            </div>
            <div>
              <dt>Identificador</dt>
              <dd className="slug">{detail.organization.slug}</dd>
            </div>
            <div>
              <dt>Descripción</dt>
              <dd>{detail.organization.description ?? "Sin descripción"}</dd>
            </div>
            <div>
              <dt>Miembros</dt>
              <dd>{detail.summary.memberCount}</dd>
            </div>
            <div>
              <dt>{canManage ? "Grupos" : "Mis grupos"}</dt>
              <dd>{detail.summary.groupCount}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
