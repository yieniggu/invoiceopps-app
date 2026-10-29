import { LinkButton } from "../../../components/LinkButton";
import { paths } from "../../navigation/paths";
import { memberRoleLabel } from "../types/roles";

/**
 * One organization: who I am in it (when I belong to it), and where to open
 * it. The platform directory also lists organizations I am not a member of.
 */
export function OrganizationCard({
  organization,
}: {
  organization: { id: string; name: string; slug: string; role?: string };
}) {
  return (
    <li className="context-card">
      <div className="card-title-row">
        <h2 className="card-title">{organization.name}</h2>
        {organization.role ? (
          <span className="role-badge">
            {memberRoleLabel(organization.role)}
          </span>
        ) : null}
      </div>
      <p className="muted">
        Identificador: <span className="slug">{organization.slug}</span>
      </p>
      <div className="action-row">
        <LinkButton
          to={paths.organization(organization.id)}
          aria-label={`Ver detalle de ${organization.name}`}
        >
          Ver detalle
        </LinkButton>
      </div>
    </li>
  );
}
