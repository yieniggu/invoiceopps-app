import { LinkButton } from "../../../components/LinkButton";
import { paths } from "../../navigation/paths";
import { memberRoleLabel } from "../types/roles";

/** One organization of mine: who I am in it, and where to manage it. */
export function OrganizationCard({
  organization,
}: {
  organization: { id: string; name: string; slug: string; role: string };
}) {
  return (
    <li className="context-card">
      <div className="card-title-row">
        <h2 className="card-title">{organization.name}</h2>
        <span className="role-badge">{memberRoleLabel(organization.role)}</span>
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
