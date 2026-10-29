import { Trash2 } from "lucide-react";
import { useId } from "react";

import { CollapsibleSection } from "../../../components/CollapsibleSection";
import { FieldMessage } from "../../../components/FieldMessage";
import type { OrganizationRole } from "../../auth/types";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import type { OrganizationDraft, OrganizationOption } from "./draft";
import { OrganizationPicker } from "./OrganizationPicker";
import { memberRoleLabel } from "../../orgs/types/roles";
import { organizationSummary } from "./summaries";

/**
 * Step 2 card of one organization of the new user: which organization, the
 * role there and the organization-level permissions. Groups are chosen in the
 * next step. Drafts only; the parent owns every value and nothing here touches
 * the network. In `fixed` mode it is an always-open card without a picker.
 */
export function OrganizationDraftCard({
  index,
  memberName,
  draft,
  organizations,
  pickerOptions,
  organizationsTotal,
  takenOrganizationIds,
  fixed,
  errorMessage,
  disabled,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  index: number;
  memberName: string;
  draft: OrganizationDraft;
  /** Every organization the wizard can name (the page plus those found by searching). */
  organizations: OrganizationOption[];
  /** The preloaded page the picker offers before any search. */
  pickerOptions: OrganizationOption[];
  /** How many organizations exist in all (more than a page when there are many). */
  organizationsTotal: number;
  /** Organizations already chosen by the other cards. */
  takenOrganizationIds: ReadonlySet<string>;
  /** Single-organization mode: the organization cannot change or be removed. */
  fixed: boolean;
  /** Visible validation message (already gated by the "attempted" flag). */
  errorMessage: string;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (next: OrganizationDraft) => void;
  onRemove: () => void;
}) {
  const organizationMessageId = useId();
  const organization = organizations.find(
    ({ id }) => id === draft.organizationId,
  );
  const title = fixed
    ? `Organización ${organization?.name ?? ""}`.trim()
    : `Organización ${index + 1}`;

  return (
    <CollapsibleSection
      title={title}
      summary={organizationSummary(
        organization?.name,
        memberRoleLabel(draft.role),
        draft.permissions,
      )}
      open={open}
      onToggle={onToggle}
      collapsible={!fixed}
      actions={
        fixed ? null : (
          <button
            type="button"
            className="subtle-danger-button"
            disabled={disabled}
            aria-label={`Quitar organización ${organization?.name ?? index + 1}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" focusable="false" size={16} />
            Quitar organización
          </button>
        )
      }
    >
      <div className="screen-stack">
        {fixed ? null : (
          <>
            <OrganizationPicker
              value={draft.organizationId}
              current={draft.picked}
              options={pickerOptions}
              total={organizationsTotal}
              taken={takenOrganizationIds}
              disabled={disabled}
              invalid={errorMessage !== ""}
              describedBy={organizationMessageId}
              onPick={(option) =>
                // Groups belong to one organization: a new choice drops them.
                onChange({
                  ...draft,
                  organizationId: option?.id ?? "",
                  picked: option,
                  groups: [],
                })
              }
            />
            <FieldMessage id={organizationMessageId} text={errorMessage} />
          </>
        )}
        <label>
          Rol en la organización
          <select
            value={draft.role}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...draft,
                role: event.target.value as OrganizationRole,
              })
            }
          >
            <option value="USER">{memberRoleLabel("USER")}</option>
            <option value="ADMIN">{memberRoleLabel("ADMIN")}</option>
          </select>
        </label>
        <MemberPermissionsEditor
          memberName={memberName}
          level="organization"
          scopeName={fixed ? undefined : organization?.name}
          value={draft.permissions}
          onChange={(permissions) => onChange({ ...draft, permissions })}
          disabled={disabled}
        />
      </div>
    </CollapsibleSection>
  );
}
