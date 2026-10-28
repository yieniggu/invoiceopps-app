import { useId, useState, type FormEvent } from "react";

import { MAX_BULK_MEMBERS } from "../../../lib/limits";
import { describeError } from "../../auth/api/apiError";
import {
  NO_PERMISSIONS,
  samePermissions,
  type InvoicePermissions,
} from "../types";
import {
  MemberPermissionsEditor,
  type PermissionsLevel,
} from "./MemberPermissionsEditor";

interface BulkPerson {
  id: string;
  name: string;
  permissions: InvoicePermissions;
}

/**
 * Sets the same four flags on several people at once. The draft only holds
 * what the person edited; until then the editor shows what everybody shares.
 */
export function BulkPermissionsForm({
  level,
  scopeName,
  people,
  ignoredCount,
  isPending,
  error,
  onApply,
}: {
  level: PermissionsLevel;
  scopeName?: string;
  /** The selected people that still exist, in the order of the selection. */
  people: readonly BulkPerson[];
  /** Selected ids that no longer exist and were left out. */
  ignoredCount: number;
  isPending: boolean;
  error: unknown;
  onApply: (userIds: string[], permissions: InvoicePermissions) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<InvoicePermissions>();
  // The editor starts from the flags everybody shares, or none when they differ.
  const first = people[0];
  const uniform = first
    ? people.every((p) => samePermissions(p.permissions, first.permissions))
    : true;
  const value =
    draft ?? (first && uniform ? first.permissions : NO_PERMISSIONS);
  const count = people.length;
  const tooMany = count > MAX_BULK_MEMBERS;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isPending || count === 0 || tooMany) return;
    onApply(
      people.map(({ id }) => id),
      { ...value },
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby={titleId}>
      <h2 id={titleId}>
        {count === 1 ? "Persona seleccionada" : "Personas seleccionadas"}
      </h2>
      <ul className="chip-list">
        {people.map(({ id, name }) => (
          <li key={id}>{name}</li>
        ))}
      </ul>
      {ignoredCount > 0 ? (
        <p role="status">
          {ignoredCount === 1
            ? "1 persona de la selección ya no está disponible y se omitió."
            : `${ignoredCount} personas de la selección ya no están disponibles y se omitieron.`}
        </p>
      ) : null}
      {!uniform ? (
        <p className="muted">
          Las personas seleccionadas tienen permisos distintos. Lo que elijas
          reemplazará los de todas.
        </p>
      ) : null}
      <MemberPermissionsEditor
        memberName={
          count === 1 ? (people[0]?.name ?? "") : "las personas seleccionadas"
        }
        level={level}
        scopeName={scopeName}
        value={value}
        onChange={setDraft}
        disabled={isPending}
      />
      {tooMany ? (
        <p role="alert">
          Puedes editar hasta {MAX_BULK_MEMBERS} personas por operación.
        </p>
      ) : null}
      {error ? (
        <p role="alert">
          {describeError(
            error,
            "No fue posible aplicar los permisos. No se cambió nada; intenta nuevamente.",
          )}
        </p>
      ) : null}
      <button type="submit" disabled={isPending || count === 0 || tooMany}>
        {isPending
          ? "Aplicando..."
          : `Aplicar a ${count} ${count === 1 ? "miembro" : "miembros"}`}
      </button>
    </form>
  );
}
