import type { ReactNode } from "react";
import { useParams } from "react-router";

import { BackLink } from "../../../components/BackLink";
import { PageHeader } from "../../../components/PageHeader";
import type { Profile } from "../../auth/types";
import { NotFoundScreen } from "../../navigation/NotFoundScreen";
import { paths } from "../../navigation/paths";
import { useOrganizationAccess } from "../hooks/useOrganizationAccess";

export interface OrganizationContext {
  organization: { id: string; name: string; slug: string };
  /** Organization ADMIN or platform administrator. */
  canManage: boolean;
}

/**
 * Resolves the organization of the URL for every organization screen. A
 * person with no membership gets the not-found page (the organization is not
 * theirs, whether or not it exists); with `manageOnly`, a plain member sees a
 * forbidden message instead of the screen.
 */
export function OrganizationGate({
  profile,
  manageOnly = false,
  forbiddenTitle = "Organización",
  forbiddenMessage = "No tienes permiso para administrar esta organización.",
  children,
}: {
  profile: Profile;
  manageOnly?: boolean;
  forbiddenTitle?: string;
  forbiddenMessage?: string;
  children: (context: OrganizationContext) => ReactNode;
}) {
  const { organizationId = "" } = useParams();
  const access = useOrganizationAccess(profile, organizationId);
  if (!access.organization) {
    return (
      <NotFoundScreen description="No encontramos esa organización entre las tuyas." />
    );
  }
  if (manageOnly && !access.canManage) {
    return (
      <div className="screen-stack">
        <BackLink to={paths.organization(access.organization.id)}>
          {access.organization.name}
        </BackLink>
        <PageHeader title={forbiddenTitle} />
        <p role="alert">{forbiddenMessage}</p>
      </div>
    );
  }
  return children({
    organization: access.organization,
    canManage: access.canManage,
  });
}
