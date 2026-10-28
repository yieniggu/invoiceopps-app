import { Trash2 } from "lucide-react";
import { useId } from "react";

import { CollapsibleSection } from "../../../components/CollapsibleSection";
import { FieldMessage } from "../../../components/FieldMessage";
import { MAX_TOTAL_GROUP_GRANTS } from "../../../lib/limits";
import { useGroupsQuery } from "../../groups/hooks/useGroups";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import { emptyGroup, type GroupDraft, type OrganizationDraft } from "./draft";
import type { OrganizationOption } from "./OrganizationDraftCard";
import { groupCountLabel, groupSummary } from "./summaries";

/**
 * Step 3: the groups of every chosen organization, one section per
 * organization. Each organization only offers its own groups, a group can be
 * added once, and every section and group folds behind a chevron.
 */
export function GroupsStep({
  memberName,
  organizations,
  options,
  fixed,
  errors,
  disabled,
  limitReached,
  collapsedOrganizations,
  openGroups,
  onToggleOrganization,
  onToggleGroup,
  onGroupAdded,
  onChange,
}: {
  memberName: string;
  /** Organization drafts that already have an organization chosen. */
  organizations: OrganizationDraft[];
  options: OrganizationOption[];
  fixed: boolean;
  /** Visible message per group draft key (gated by the "attempted" flag). */
  errors: Record<string, string>;
  disabled: boolean;
  /** The groups of all organizations together are at the server's cap. */
  limitReached: boolean;
  collapsedOrganizations: ReadonlySet<string>;
  openGroups: ReadonlySet<string>;
  onToggleOrganization: (key: string) => void;
  onToggleGroup: (key: string) => void;
  /** A new group draft was appended: the parent folds the rest and opens it. */
  onGroupAdded: (organizationKey: string, groupKey: string) => void;
  onChange: (next: OrganizationDraft) => void;
}) {
  if (organizations.length === 0)
    return (
      <p className="muted">
        Sin organizaciones seleccionadas; puedes continuar.
      </p>
    );
  return (
    <>
      {organizations.map((draft) => (
        <OrganizationGroups
          key={draft.key}
          memberName={memberName}
          draft={draft}
          organization={options.find(({ id }) => id === draft.organizationId)}
          fixed={fixed}
          errors={errors}
          disabled={disabled}
          limitReached={limitReached}
          open={!collapsedOrganizations.has(draft.key)}
          openGroups={openGroups}
          onToggle={() => onToggleOrganization(draft.key)}
          onToggleGroup={onToggleGroup}
          onGroupAdded={onGroupAdded}
          onChange={onChange}
        />
      ))}
    </>
  );
}

function OrganizationGroups({
  memberName,
  draft,
  organization,
  fixed,
  errors,
  disabled,
  limitReached,
  open,
  openGroups,
  onToggle,
  onToggleGroup,
  onGroupAdded,
  onChange,
}: {
  memberName: string;
  draft: OrganizationDraft;
  organization: OrganizationOption | undefined;
  fixed: boolean;
  errors: Record<string, string>;
  disabled: boolean;
  limitReached: boolean;
  open: boolean;
  openGroups: ReadonlySet<string>;
  onToggle: () => void;
  onToggleGroup: (key: string) => void;
  onGroupAdded: (organizationKey: string, groupKey: string) => void;
  onChange: (next: OrganizationDraft) => void;
}) {
  const groups = useGroupsQuery(draft.organizationId, true);
  const organizationName = organization?.name ?? "";
  const available = (groups.data ?? []).filter(
    ({ id }) => !draft.groups.some((chosen) => chosen.groupId === id),
  );
  const noGroupsAtAll = groups.data !== undefined && groups.data.length === 0;
  const allAdded =
    groups.data !== undefined &&
    groups.data.length > 0 &&
    available.length === 0;

  const changeGroup = (key: string, patch: Partial<GroupDraft>) =>
    onChange({
      ...draft,
      groups: draft.groups.map((group) =>
        group.key === key ? { ...group, ...patch } : group,
      ),
    });
  const addGroup = () => {
    const added = emptyGroup();
    onChange({ ...draft, groups: [...draft.groups, added] });
    onGroupAdded(draft.key, added.key);
  };

  return (
    <CollapsibleSection
      title={`Grupos de ${organizationName}`}
      summary={`${organizationName} · ${groupCountLabel(draft.groups.length)}`}
      open={open}
      onToggle={onToggle}
      collapsible={!fixed}
    >
      <div className="screen-stack">
        {groups.isError ? (
          <>
            <p role="alert">No fue posible cargar los grupos.</p>
            <button type="button" onClick={() => void groups.refetch()}>
              Reintentar grupos
            </button>
          </>
        ) : null}
        {groups.isPending ? (
          <p role="status" className="muted">
            Cargando grupos...
          </p>
        ) : null}
        {noGroupsAtAll ? (
          <p className="muted">Esta organización no tiene grupos.</p>
        ) : null}
        {draft.groups.map((group, index) => (
          <GroupDraftCard
            key={group.key}
            index={index}
            organizationName={organizationName}
            memberName={memberName}
            draft={group}
            options={[
              ...(groups.data ?? []).filter(({ id }) => id === group.groupId),
              ...available,
            ]}
            error={errors[group.key] ?? ""}
            disabled={disabled}
            open={openGroups.has(group.key)}
            onToggle={() => onToggleGroup(group.key)}
            onChange={(patch) => changeGroup(group.key, patch)}
            onRemove={() =>
              onChange({
                ...draft,
                groups: draft.groups.filter(({ key }) => key !== group.key),
              })
            }
          />
        ))}
        {noGroupsAtAll || groups.isError ? null : (
          <div className="action-row">
            <button
              type="button"
              className="secondary-button"
              disabled={
                disabled ||
                !groups.data ||
                available.length === 0 ||
                limitReached
              }
              onClick={addGroup}
            >
              Agregar a un grupo
            </button>
            {limitReached ? (
              <span className="muted">
                Alcanzaste el máximo de {MAX_TOTAL_GROUP_GRANTS} grupos en total
                para un usuario.
              </span>
            ) : null}
            {allAdded ? (
              <span className="muted">
                Ya agregaste todos los grupos disponibles.
              </span>
            ) : null}
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}

function GroupDraftCard({
  index,
  organizationName,
  memberName,
  draft,
  options,
  error,
  disabled,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  index: number;
  organizationName: string;
  memberName: string;
  draft: GroupDraft;
  options: Array<{ id: string; name: string }>;
  error: string;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<GroupDraft>) => void;
  onRemove: () => void;
}) {
  const messageId = useId();
  return (
    <CollapsibleSection
      title={`Grupo ${index + 1}`}
      summary={groupSummary(draft.groupName, draft.permissions)}
      open={open}
      onToggle={onToggle}
      headingLevel={4}
      actions={
        <button
          type="button"
          className="subtle-danger-button"
          disabled={disabled}
          aria-label={`Quitar grupo ${draft.groupName || index + 1} de ${organizationName}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" focusable="false" size={16} />
          Quitar grupo
        </button>
      }
    >
      <div className="screen-stack">
        <label>
          Grupo
          <select
            value={draft.groupId}
            disabled={disabled}
            aria-invalid={error !== ""}
            aria-describedby={messageId}
            onChange={(event) =>
              onChange({
                groupId: event.target.value,
                groupName:
                  options.find(({ id }) => id === event.target.value)?.name ??
                  "",
              })
            }
          >
            <option value="">Selecciona un grupo</option>
            {/* The chosen group is not among the options (it no longer
                exists, or the list is not loaded): show it, as unavailable,
                instead of a placeholder that hides the stale choice. */}
            {draft.groupId &&
            !options.some(({ id }) => id === draft.groupId) ? (
              <option value={draft.groupId}>
                {draft.groupName || "Grupo"} (no disponible)
              </option>
            ) : null}
            {options.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <FieldMessage id={messageId} text={error} />
        {draft.groupId ? (
          <MemberPermissionsEditor
            memberName={memberName}
            level="group"
            scopeName={draft.groupName}
            value={draft.permissions}
            onChange={(permissions) => onChange({ permissions })}
            disabled={disabled}
          />
        ) : null}
      </div>
    </CollapsibleSection>
  );
}
