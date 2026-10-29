import { useId, type FormEvent, type ReactNode, type RefObject } from "react";

import { FieldMessage } from "../../../components/FieldMessage";
import { RutField } from "../../../components/RutField";

export interface OrganizationFormValues {
  name: string;
  slug: string;
  description: string;
  firstAdminRut: string;
}

type TextField = "name" | "slug" | "description" | "firstAdminRut";

/**
 * Presentational organization form. In `create` mode it asks for the data and
 * the first administrator; in `edit` mode only name and description are
 * editable, the slug is shown read-only (it is immutable) and there is no
 * first administrator.
 */
export function OrganizationForm({
  mode = "create",
  values,
  onChange,
  invalid,
  nameMessage,
  slugMessage,
  pending = false,
  submitted = false,
  nameInput,
  slugInput,
  rutInput,
  onSubmit,
  children,
}: {
  mode?: "create" | "edit";
  values: OrganizationFormValues;
  onChange?: (field: TextField, value: string) => void;
  invalid?: "name" | "slug";
  nameMessage?: string;
  slugMessage?: string;
  pending?: boolean;
  submitted?: boolean;
  nameInput?: RefObject<HTMLInputElement | null>;
  slugInput?: RefObject<HTMLInputElement | null>;
  rutInput?: RefObject<HTMLInputElement | null>;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Feedback and the submit button belong to the screen's container. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const nameMessageId = useId();
  const slugMessageId = useId();
  const set = (field: TextField) => (value: string) => onChange?.(field, value);

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>Datos de la organización</h2>
      <label>
        Nombre de la organización
        <input
          ref={nameInput}
          value={values.name}
          onChange={(event) => set("name")(event.target.value)}
          disabled={pending}
          aria-invalid={invalid === "name"}
          aria-describedby={nameMessageId}
          required
        />
      </label>
      <FieldMessage id={nameMessageId} text={nameMessage ?? ""} />
      {mode === "edit" ? (
        <p>
          Identificador (no se puede cambiar):{" "}
          <span className="slug">{values.slug}</span>
        </p>
      ) : (
        <>
          <label>
            Identificador (slug)
            <input
              ref={slugInput}
              value={values.slug}
              onChange={(event) => set("slug")(event.target.value)}
              disabled={pending}
              aria-invalid={invalid === "slug"}
              aria-describedby={slugMessageId}
              required
            />
          </label>
          <FieldMessage id={slugMessageId} text={slugMessage ?? ""} />
        </>
      )}
      <label>
        Descripción (opcional)
        <input
          value={values.description}
          onChange={(event) => set("description")(event.target.value)}
          disabled={pending}
        />
      </label>
      {mode === "create" ? (
        <RutField
          label="RUT del primer administrador"
          missingMessage="Ingresa el RUT"
          value={values.firstAdminRut}
          onChange={set("firstAdminRut")}
          disabled={pending}
          submitted={submitted}
          inputRef={rutInput}
          required
        />
      ) : null}
      {children}
    </form>
  );
}
