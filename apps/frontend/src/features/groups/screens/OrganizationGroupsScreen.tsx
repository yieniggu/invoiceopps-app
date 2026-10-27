import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useOrganizationAccess } from "../../orgs/hooks/useOrganizationAccess";
import { GroupsList } from "../components/GroupsList";

/** The groups of a single organization. */
export function OrganizationGroupsScreen({ profile }: { profile: Profile }) {
  const { organizationId = "" } = useParams();
  const { organization, isAdmin } = useOrganizationAccess(
    profile,
    organizationId,
  );
  if (!organization) {
    return (
      <NotFoundScreen description="No encontramos esa organización entre las tuyas." />
    );
  }
  return (
    <div className="screen-stack">
      <BackLink to={paths.organization(organization.id)}>
        {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Grupos de la organización"
        description={
          isAdmin
            ? "Como administrador ves todos los grupos de la organización y puedes crear nuevos."
            : "Los grupos de esta organización a los que perteneces y lo que puedes hacer en ellos."
        }
        action={
          isAdmin ? (
            <LinkButton to={paths.newGroup(organization.id)}>
              Crear grupo
            </LinkButton>
          ) : undefined
        }
      />
      <GroupsList organizationId={organization.id} isAdmin={isAdmin} />
    </div>
  );
}
