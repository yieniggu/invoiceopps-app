import { LinkButton } from "../../../components/LinkButton";
import { paths } from "../../navigation/paths";
import type { Group } from "../types";
import {
  describePermissions,
  type InvoicePermissions,
} from "../../permissions/types";

/** One group: what my membership lets me do in it, and where to open it. */
export function GroupRow({
  organizationId,
  group,
  effective,
}: {
  organizationId: string;
  group: Group;
  /** My effective flags in this group (presentation only), when I belong. */
  effective?: InvoicePermissions;
}) {
  return (
    <li className="context-card">
      <h3 className="card-title">{group.name}</h3>
      {group.description ? <p>{group.description}</p> : null}
      {effective ? (
        <p className="muted">{describePermissions(effective)}</p>
      ) : null}
      <div className="action-row">
        <LinkButton
          to={paths.group(organizationId, group.id)}
          aria-label={`Ver grupo ${group.name}`}
        >
          Ver grupo
        </LinkButton>
      </div>
    </li>
  );
}
