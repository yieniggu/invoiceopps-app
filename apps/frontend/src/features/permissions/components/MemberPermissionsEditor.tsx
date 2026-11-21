import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";

import { PendingButton } from "../../../components/PendingButton";
import { describeError } from "../../auth/api/apiError";
import { PermissionRatio } from "./DeployModelsIndicator";
import {
  useSavePermissions,
  type PermissionsTarget,
} from "../hooks/useSavePermissions";
import {
  MODEL_PERMISSION_LABEL,
  withInvoiceFlags,
  PERMISSION_LABELS,
  samePermissions,
  type InvoicePermissions,
} from "../types";

export type PermissionsLevel = "organization" | "group";

const LEVEL_LABEL: Record<PermissionsLevel, string> = {
  organization: "Permisos en la organización",
  group: "Permisos en el grupo",
};

/**
 * One flag as a toggle button: the icon (+ turns it on, − turns it off) and
 * the active border and background show the state without relying on color
 * alone. `aria-pressed` carries it for assistive tech; there is no state text.
 */
function PermissionToggle({
  label,
  on,
  locked,
  onToggle,
}: {
  label: string;
  on: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  const Icon = on ? Minus : Plus;
  return (
    <button
      type="button"
      className={`permission-toggle${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-disabled={locked || undefined}
      onClick={() => {
        if (!locked) onToggle();
      }}
    >
      <Icon aria-hidden="true" focusable="false" size={18} />
      <span className="permission-toggle-label">{label}</span>
    </button>
  );
}

/**
 * The independent flags at one level (four invoice flags and the model flag). This is the controlled "draft"
 * mode: no network, the parent owns the value (forms that create things).
 * `SavedMemberPermissionsEditor` adds the save flow for existing members.
 * With `collapsible` the editor folds behind a chevron and shows "n de 4
 * permisos" while folded. `disabled` locks the controls with `aria-disabled`
 * (and ignores their clicks) instead of the `disabled` attribute: a disabled
 * control that has focus sends it to the page.
 */
export function MemberPermissionsEditor({
  memberName,
  level,
  scopeName,
  value,
  onChange,
  disabled = false,
  collapsible = false,
  defaultOpen = true,
}: {
  memberName: string;
  level: PermissionsLevel;
  /** Organization or group the flags apply to, when the screen shows several. */
  scopeName?: string;
  value: InvoicePermissions;
  onChange: (next: InvoicePermissions) => void;
  disabled?: boolean;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const scope = scopeName ? ` «${scopeName}»` : "";
  const legend = `${LEVEL_LABEL[level]}${scope} — ${memberName}`;
  const expanded = !collapsible || open;
  const summary = <PermissionRatio permissions={value} />;

  const body = (
    <>
      <div className="permission-bulk-actions">
        <button
          type="button"
          className="secondary-button"
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onChange(withInvoiceFlags(value, true));
          }}
        >
          Marcar todos
        </button>
        <button
          type="button"
          className="secondary-button"
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) onChange(withInvoiceFlags(value, false));
          }}
        >
          Desmarcar todos
        </button>
      </div>
      <div className="permission-toggles">
        {PERMISSION_LABELS.map(([flag, label]) => (
          <PermissionToggle
            key={flag}
            label={label}
            on={value[flag]}
            locked={disabled}
            onToggle={() => onChange({ ...value, [flag]: !value[flag] })}
          />
        ))}
        <PermissionToggle
          label={MODEL_PERMISSION_LABEL[1]}
          on={value.deployModels}
          locked={disabled}
          onToggle={() =>
            onChange({ ...value, deployModels: !value.deployModels })
          }
        />
      </div>
    </>
  );

  return (
    <fieldset className="permission-grid">
      <legend>{legend}</legend>
      {collapsible ? (
        <button
          type="button"
          className="collapse-toggle permission-collapse"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" focusable="false" size={18} />
          ) : (
            <ChevronRight aria-hidden="true" focusable="false" size={18} />
          )}
          <span>{expanded ? "Ocultar permisos" : "Ver permisos"}</span>
          <span className="muted">{summary}</span>
        </button>
      ) : null}
      <div id={bodyId} className="permission-body" hidden={!expanded}>
        {body}
      </div>
    </fieldset>
  );
}

/**
 * Saved mode, used for existing members. `saved` is the server value straight
 * from the list query; the local draft only holds what the person changed, so
 * a refetch after saving shows the confirmed flags without a second copy.
 */
export function SavedMemberPermissionsEditor({
  memberName,
  scopeName,
  target,
  saved,
  collapsible,
  defaultOpen,
}: {
  memberName: string;
  scopeName?: string;
  target: PermissionsTarget;
  saved: InvoicePermissions;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const save = useSavePermissions(target);
  const [draft, setDraft] = useState<InvoicePermissions>();
  const value = draft ?? saved;
  const dirty = draft !== undefined && !samePermissions(draft, saved);

  const submit = () => {
    if (!dirty || save.isPending) return;
    // All four flags travel together so the replacement is atomic.
    save.mutate(
      { ...value },
      // The lists are refetched before this runs, so `saved` is already fresh.
      { onSuccess: () => setDraft(undefined) },
    );
  };

  const status = save.isError
    ? describeError(
        save.error,
        "No fue posible guardar los permisos. Tus cambios siguen en pantalla; intenta nuevamente.",
      )
    : save.isSuccess && !dirty
      ? "Permisos guardados"
      : "";

  return (
    <div className="permission-editor">
      <MemberPermissionsEditor
        memberName={memberName}
        level={target.level}
        scopeName={scopeName}
        value={value}
        disabled={save.isPending}
        collapsible={collapsible}
        defaultOpen={defaultOpen}
        onChange={(next) => {
          // A new edit retires the previous outcome message.
          if (!save.isPending) save.reset();
          setDraft(next);
        }}
      />
      <div className="action-row">
        <PendingButton
          type="button"
          disabled={!dirty || save.isPending}
          pending={save.isPending}
          announce={{ pending: "Guardando permisos" }}
          aria-label={`Guardar permisos de ${memberName}`}
          onClick={submit}
        >
          Guardar
        </PendingButton>
        <p
          role="status"
          aria-live="polite"
          className={save.isError ? "field-error" : "muted"}
        >
          {status}
        </p>
      </div>
    </div>
  );
}
