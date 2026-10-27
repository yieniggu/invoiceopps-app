import { useId } from "react";

import { fromApiRut } from "../../../lib/rut";
import type { OrganizationUser } from "../../users/types";

/** Checkbox list of the organization's people for the new group. */
export function GroupMemberPicker({
  users,
  selected,
  onToggle,
  disabled,
  isLoading,
  isError,
  onRetry,
}: {
  users: OrganizationUser[] | undefined;
  selected: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  disabled: boolean;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const titleId = useId();
  return (
    <fieldset
      className="permission-grid"
      aria-labelledby={titleId}
      disabled={disabled}
    >
      <legend id={titleId}>Miembros iniciales (opcional)</legend>
      {isLoading ? (
        <p role="status">Cargando personas de la organización...</p>
      ) : null}
      {isError ? (
        <>
          <p role="alert">
            No fue posible cargar las personas de la organización.
          </p>
          <button type="button" onClick={onRetry}>
            Reintentar personas
          </button>
        </>
      ) : null}
      {users && users.length === 0 ? (
        <p>La organización aún no tiene personas para agregar.</p>
      ) : null}
      {(users ?? []).map((user) => (
        <label key={user.id}>
          <input
            type="checkbox"
            checked={selected.has(user.id)}
            onChange={() => onToggle(user.id)}
          />
          {user.name} <span className="muted">({fromApiRut(user.rut)})</span>
        </label>
      ))}
    </fieldset>
  );
}
