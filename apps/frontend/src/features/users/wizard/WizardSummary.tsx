import { describePermissions } from "../../permissions/types";
import type { UserDraft } from "./draft";
import type { OrganizationOption } from "./OrganizationDraftCard";
import { memberRoleLabel } from "../../orgs/types/roles";

/** Read-only recap of everything the server will receive. */
export function WizardSummary({
  draft,
  organizations,
  rutLabel,
}: {
  draft: UserDraft;
  organizations: OrganizationOption[];
  /** The RUT as the person typed it (already formatted). */
  rutLabel: string;
}) {
  return (
    <div className="screen-stack">
      <dl>
        <dt>Nombre</dt>
        <dd>{draft.name.trim()}</dd>
        <dt>RUT</dt>
        <dd>{rutLabel}</dd>
        <dt>Contraseña temporal</dt>
        <dd>
          {draft.passwordMode === "defined"
            ? "Definida por ti (no se muestra)"
            : "Generada automáticamente (se muestra una sola vez)"}
        </dd>
      </dl>
      {draft.organizations.length === 0 ? (
        <p>
          Sin organizaciones: el usuario se crea sin acceso a ninguna
          organización.
        </p>
      ) : (
        <ul className="card-list">
          {draft.organizations.map((organization) => (
            <li key={organization.key} className="context-card">
              <h3 className="card-title">
                {organizations.find(
                  ({ id }) => id === organization.organizationId,
                )?.name ?? organization.organizationId}
              </h3>
              <p>Rol: {memberRoleLabel(organization.role)}</p>
              <p className="muted">
                En la organización:{" "}
                {describePermissions(organization.permissions)}
              </p>
              {organization.groups.length === 0 ? (
                <p className="muted">Sin grupos.</p>
              ) : (
                <ul>
                  {organization.groups.map((group) => (
                    <li key={group.key}>
                      Grupo {group.groupName}:{" "}
                      {describePermissions(group.permissions)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
