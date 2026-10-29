import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";

import { Dialog } from "../../../components/Dialog";
import { FieldMessage } from "../../../components/FieldMessage";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { RutField } from "../../../components/RutField";
import { cleanRut, fromApiRut, isValidRut, toApiRut } from "../../../lib/rut";
import { isApiError } from "../../auth/api/apiError";
import { useUpdateAdminUser } from "../hooks/useAdminUsers";
import type { AdminUser, UpdateAdminUserInput } from "../types";

const MESSAGES = {
  USER_CONFLICT: "Ya existe una persona con ese RUT.",
  SELF_ACTION_FORBIDDEN: "No puedes cambiar tu propio RUT.",
};

/**
 * Name and RUT of another person. Your own RUT is not editable (the server
 * refuses it with SELF_ACTION_FORBIDDEN), so for your own account the field is
 * simply not offered.
 */
export function EditAdminUserDialog({
  user,
  isSelf,
  onClose,
  returnFocusTo,
}: {
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const update = useUpdateAdminUser(user.id);
  const [name, setName] = useState(user.name);
  const [rut, setRut] = useState(fromApiRut(user.rut));
  const [submitted, setSubmitted] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const rutInput = useRef<HTMLInputElement>(null);
  const nameMessageId = useId();

  // A duplicate RUT is reported on the field, never as a second alert; the
  // message goes away as soon as the RUT is edited.
  const rejectedAsDuplicate =
    update.isError &&
    isApiError(update.error) &&
    update.error.code === "USER_CONFLICT";
  const conflict =
    rejectedAsDuplicate && update.variables?.rut === toApiRut(rut);

  // The conflict is shown next to the field: focus it once it can take focus
  // again (it is disabled while the request runs).
  useEffect(() => {
    if (conflict) rutInput.current?.focus();
  }, [conflict]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending) return;
    setSubmitted(true);
    const trimmed = name.trim();
    if (!trimmed) {
      setNameMissing(true);
      nameInput.current?.focus();
      return;
    }
    setNameMissing(false);
    if (!isSelf && !isValidRut(rut)) {
      rutInput.current?.focus();
      return;
    }
    const input: UpdateAdminUserInput = {};
    if (trimmed !== user.name) input.name = trimmed;
    if (!isSelf && cleanRut(rut) !== cleanRut(user.rut))
      input.rut = toApiRut(rut);
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    update.mutate(input, {
      onSuccess: onClose,
    });
  };

  return (
    <Dialog
      title="Editar usuario"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <form onSubmit={submit} noValidate>
        <label>
          Nombre
          <input
            ref={nameInput}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={update.isPending}
            aria-invalid={nameMissing}
            aria-describedby={nameMessageId}
            required
          />
        </label>
        <FieldMessage
          id={nameMessageId}
          text={nameMissing ? "Ingresa el nombre." : ""}
        />
        {isSelf ? (
          <p className="field-hint">
            Tu propio RUT no se puede cambiar desde aquí.
          </p>
        ) : (
          <RutField
            label="RUT"
            value={rut}
            onChange={setRut}
            disabled={update.isPending}
            submitted={submitted}
            inputRef={rutInput}
            serverMessage={conflict ? MESSAGES.USER_CONFLICT : ""}
            required
          />
        )}
        <div className="action-row">
          <button type="submit" disabled={update.isPending}>
            {update.isPending ? "Guardando..." : "Guardar cambios"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={update.isPending}
            onClick={onClose}
          >
            Cancelar
          </button>
        </div>
        {rejectedAsDuplicate ? null : (
          <MutationFeedback
            isError={update.isError}
            error={update.error}
            isSuccess={false}
            success=""
            fallback="No fue posible guardar los cambios. Intenta nuevamente."
            messages={MESSAGES}
            focusOnError
          />
        )}
      </form>
    </Dialog>
  );
}
