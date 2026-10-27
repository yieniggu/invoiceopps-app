import { LinkButton } from "../../../components/LinkButton";
import { paths } from "../../navigation/paths";
import {
  contextValue,
  useSharedWorkspace,
} from "../../workspace/WorkspaceContext";
import type { Group } from "../types";
import { describePermissions } from "../types/permissions";

/** One group: what it is allowed to do and where to open it. */
export function GroupRow({
  organizationId,
  group,
}: {
  organizationId: string;
  group: Group;
}) {
  const workspace = useSharedWorkspace();
  const context = workspace.contexts.find(
    (candidate) =>
      candidate.ownerType === "group" &&
      candidate.ownerId === group.id &&
      candidate.organizationId === organizationId,
  );
  return (
    <li className="context-card">
      <h3 className="card-title">{group.name}</h3>
      {group.description ? <p>{group.description}</p> : null}
      <p className="muted">{describePermissions(group.permissions)}</p>
      <div className="action-row">
        <LinkButton
          to={paths.group(organizationId, group.id)}
          aria-label={`Ver detalle de ${group.name}`}
        >
          Ver detalle
        </LinkButton>
        {context ? (
          <button
            type="button"
            className="secondary-button"
            aria-pressed={workspace.selectedValue === contextValue(context)}
            onClick={() => workspace.setSelectedValue(contextValue(context))}
          >
            Trabajar con {group.name}
          </button>
        ) : null}
      </div>
    </li>
  );
}
