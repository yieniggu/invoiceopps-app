import { useId, type FormEvent, type ReactNode, type RefObject } from "react";

import { FieldMessage } from "../../../components/FieldMessage";
import { PERMISSION_LABELS, type GroupPermissions } from "../types";

export interface GroupFormValues {
  name: string;
  description: string;
}

/**
 * Presentational group form. `create` edits everything; `view` shows name and
 * description read-only (the API cannot rename a group) and edits only the
 * permissions, and only when `permissionsEditable` allows it.
 */
export function GroupForm({
  mode,
  values,
  permissions,
  onValuesChange,
  onPermissionsChange,
  permissionsEditable,
  nameMessage = "",
  nameInput,
  pending = false,
  submitLabel,
  pendingLabel,
  onSubmit,
  members,
  feedback,
}: {
  mode: "create" | "view";
  values: GroupFormValues;
  permissions: GroupPermissions;
  onValuesChange?: (field: keyof GroupFormValues, value: string) => void;
  onPermissionsChange?: (next: GroupPermissions) => void;
  permissionsEditable: boolean;
  nameMessage?: string;
  nameInput?: RefObject<HTMLInputElement | null>;
  pending?: boolean;
  /** Without a label there is no submit button (read-only viewers). */
  submitLabel?: string;
  pendingLabel?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Member selection of the create flow. */
  members?: ReactNode;
  feedback?: ReactNode;
}) {
  const creating = mode === "create";
  const titleId = useId();
  const nameMessageId = useId();
  const textLocked = !creating || pending;

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>
        {creating ? "Datos del grupo" : "Información del grupo"}
      </h2>
      {creating ? null : (
        <p>
          El nombre y la descripción no se pueden modificar desde la aplicación.
        </p>
      )}
      <label>
        Nombre del grupo
        <input
          ref={nameInput}
          value={values.name}
          onChange={(event) => onValuesChange?.("name", event.target.value)}
          disabled={textLocked}
          aria-invalid={nameMessage !== ""}
          aria-describedby={nameMessageId}
          required={creating}
        />
      </label>
      <FieldMessage id={nameMessageId} text={nameMessage} />
      <label>
        {creating ? "Descripción (opcional)" : "Descripción"}
        <input
          value={values.description}
          onChange={(event) =>
            onValuesChange?.("description", event.target.value)
          }
          disabled={textLocked}
        />
      </label>
      <fieldset
        className="permission-grid"
        disabled={!permissionsEditable || pending}
      >
        <legend>Permisos sobre facturas</legend>
        {PERMISSION_LABELS.map(([flag, label]) => (
          <label key={flag}>
            <input
              type="checkbox"
              checked={permissions[flag]}
              onChange={(event) =>
                onPermissionsChange?.({
                  ...permissions,
                  [flag]: event.target.checked,
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {members}
      {submitLabel ? (
        <button type="submit" disabled={pending}>
          {pending ? (pendingLabel ?? submitLabel) : submitLabel}
        </button>
      ) : null}
      {feedback}
    </form>
  );
}
