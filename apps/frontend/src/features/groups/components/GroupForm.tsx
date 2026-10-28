import { useId, type FormEvent, type ReactNode, type RefObject } from "react";

import { FieldMessage } from "../../../components/FieldMessage";

export interface GroupFormValues {
  name: string;
  description: string;
}

/**
 * Presentational create-group form: only a name and a description. People are
 * added afterwards, on the members screen of the new group (the API cannot
 * rename a group later).
 */
export function GroupForm({
  values,
  onValuesChange,
  nameMessage = "",
  nameInput,
  pending = false,
  onSubmit,
  feedback,
}: {
  values: GroupFormValues;
  onValuesChange: (field: keyof GroupFormValues, value: string) => void;
  nameMessage?: string;
  nameInput?: RefObject<HTMLInputElement | null>;
  pending?: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  feedback?: ReactNode;
}) {
  const titleId = useId();
  const nameMessageId = useId();

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>Datos del grupo</h2>
      <label>
        Nombre del grupo
        <input
          ref={nameInput}
          value={values.name}
          onChange={(event) => onValuesChange("name", event.target.value)}
          disabled={pending}
          aria-invalid={nameMessage !== ""}
          aria-describedby={nameMessageId}
          required
        />
      </label>
      <FieldMessage id={nameMessageId} text={nameMessage} />
      <label>
        Descripción (opcional)
        <input
          value={values.description}
          onChange={(event) =>
            onValuesChange("description", event.target.value)
          }
          disabled={pending}
        />
      </label>
      <button type="submit" disabled={pending}>
        {pending ? "Creando grupo..." : "Crear grupo"}
      </button>
      {feedback}
    </form>
  );
}
