import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { paths } from "../../navigation/paths";
import { OrganizationGate } from "../../orgs/components/OrganizationGate";
import { GroupsList } from "../components/GroupsList";

/** The groups of a single organization. */
export function OrganizationGroupsScreen({ profile }: { profile: Profile }) {
  return (
    <OrganizationGate profile={profile}>
      {({ organization, canManage }) => (
        <GroupsView
          key={organization.id}
          organization={organization}
          canManage={canManage}
          memberGroups={
            profile.memberships.find(
              (entry) => entry.organization.id === organization.id,
            )?.groups
          }
        />
      )}
    </OrganizationGate>
  );
}

function GroupsView({
  organization,
  canManage,
  memberGroups,
}: {
  organization: { id: string; name: string };
  canManage: boolean;
  memberGroups: Profile["memberships"][number]["groups"] | undefined;
}) {
  return (
    <div className="screen-stack">
      <BackLink to={paths.organization(organization.id)}>
        {organization.name}
      </BackLink>
      <PageHeader
        eyebrow={organization.name}
        title="Grupos de la organización"
        description={
          canManage
            ? "Como administrador ves todos los grupos de la organización y puedes crear nuevos."
            : "Los grupos de esta organización a los que perteneces y lo que puedes hacer en ellos."
        }
        action={
          canManage ? (
            <LinkButton to={paths.newGroup(organization.id)}>
              Crear grupo
            </LinkButton>
          ) : undefined
        }
      />
      <GroupsList
        organizationId={organization.id}
        isAdmin={canManage}
        memberGroups={memberGroups}
      />
    </div>
  );
}
