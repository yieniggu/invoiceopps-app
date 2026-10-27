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
 * Presentational organization form. `create` collects the data and the first
 * administrator; `view` shows the saved data read-only because the API cannot
 * edit name, slug or description.
 */
export function OrganizationForm({
  mode,
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
  mode: "create" | "view";
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
  const creating = mode === "create";
  const locked = !creating || pending;
  const titleId = useId();
  const nameMessageId = useId();
  const slugMessageId = useId();
  const set = (field: TextField) => (value: string) => onChange?.(field, value);

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>
        {creating
          ? "Datos de la organización"
          : "Información de la organización"}
      </h2>
      {creating ? null : (
        <p>
          El nombre, el identificador y la descripción no se pueden modificar
          desde la aplicación.
        </p>
      )}
      <label>
        Nombre de la organización
        <input
          ref={nameInput}
          value={values.name}
          onChange={(event) => set("name")(event.target.value)}
          disabled={locked}
          aria-invalid={invalid === "name"}
          aria-describedby={nameMessageId}
          required={creating}
        />
      </label>
      <FieldMessage id={nameMessageId} text={nameMessage ?? ""} />
      <label>
        Identificador (slug)
        <input
          ref={slugInput}
          value={values.slug}
          onChange={(event) => set("slug")(event.target.value)}
          disabled={locked}
          aria-invalid={invalid === "slug"}
          aria-describedby={slugMessageId}
          required={creating}
        />
      </label>
      <FieldMessage id={slugMessageId} text={slugMessage ?? ""} />
      <label>
        {creating ? "Descripción (opcional)" : "Descripción"}
        <input
          value={values.description}
          onChange={(event) => set("description")(event.target.value)}
          disabled={locked}
        />
      </label>
      {creating ? (
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
