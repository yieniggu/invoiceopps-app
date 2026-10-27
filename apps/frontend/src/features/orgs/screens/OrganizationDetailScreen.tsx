import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { LinkButton } from "../../../components/LinkButton";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { ProvisionUserForm } from "../../users/components/ProvisionUserForm";
import { AssignMemberForm } from "../components/AssignMemberForm";
import { MembersPanel } from "../components/MembersPanel";
import { OrganizationForm } from "../components/OrganizationForm";
import { useMyOrganizations } from "../hooks/useMyOrganizations";
import { isAdminRole } from "../types/roles";

/** One organization of mine: read-only data, plus its people for an ADMIN. */
export function OrganizationDetailScreen({ profile }: { profile: Profile }) {
  const { organizationId = "" } = useParams();
  const membership = profile.memberships.find(
    ({ organization }) => organization.id === organizationId,
  );
  // Platform authority is not membership: without one there is nothing to show.
  if (!membership) {
    return (
      <NotFoundScreen description="No encontramos esa organización entre las tuyas." />
    );
  }
  return (
    <OrganizationDetail
      profile={profile}
      organizationId={organizationId}
      organization={membership.organization}
      isAdmin={isAdminRole(membership.role)}
    />
  );
}

function OrganizationDetail({
  profile,
  organizationId,
  organization,
  isAdmin,
}: {
  profile: Profile;
  organizationId: string;
  organization: { id: string; name: string; slug: string };
  isAdmin: boolean;
}) {
  // Only the description needs the organizations read; the rest is in the profile.
  const { query, organizations } = useMyOrganizations(profile);
  const full = organizations?.find(({ id }) => id === organizationId);

  return (
    <div className="screen-stack">
      <BackLink to={paths.organizations}>Organizaciones</BackLink>
      <PageHeader
        eyebrow="Organización"
        title={organization.name}
        description={
          isAdmin
            ? "Eres administrador: gestiona aquí a las personas y los grupos de esta organización."
            : "Eres miembro de esta organización. Aquí ves su información y tus grupos."
        }
        action={
          <LinkButton to={paths.organizationGroups(organizationId)}>
            Ver grupos
          </LinkButton>
        }
      />
      <OrganizationForm
        mode="view"
        values={{
          name: organization.name,
          slug: organization.slug,
          description: full?.description ?? "",
          firstAdminRut: "",
        }}
      >
        {query.isError ? (
          <>
            <p role="alert">
              No fue posible cargar la descripción de la organización.
            </p>
            <button type="button" onClick={() => void query.refetch()}>
              Reintentar organización
            </button>
          </>
        ) : null}
      </OrganizationForm>
      {isAdmin ? (
        // Keyed so a form never carries values into another organization.
        <div className="screen-stack" key={organizationId}>
          <MembersPanel organizationId={organizationId} />
          <div className="screen-grid">
            <AssignMemberForm organizationId={organizationId} />
            <ProvisionUserForm organizationId={organizationId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
