import { useId, useState, type FormEvent } from "react";

import { PendingButton } from "../../../components/PendingButton";
import { MAX_BULK_MEMBERS } from "../../../lib/limits";
import { describeError } from "../../auth/api/apiError";
import {
  NO_PERMISSIONS,
  type BulkPermissions,
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
  onApply: (userIds: string[], permissions: BulkPermissions) => void;
}) {
  const titleId = useId();
  const [draft, setDraft] = useState<InvoicePermissions>();
  // `deployModels` travels only if the admin touched its toggle (CR-590).
  const [deployTouched, setDeployTouched] = useState(false);
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
    const { deployModels, ...invoiceFlags } = value;
    onApply(
      people.map(({ id }) => id),
      deployTouched ? { ...invoiceFlags, deployModels } : invoiceFlags,
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
        onChange={(next) => {
          if (next.deployModels !== value.deployModels) setDeployTouched(true);
          setDraft(next);
        }}
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
      <PendingButton
        type="submit"
        disabled={isPending || count === 0 || tooMany}
        pending={isPending}
        announce={{ pending: "Aplicando permisos" }}
      >
        {`Aplicar a ${count} ${count === 1 ? "miembro" : "miembros"}`}
      </PendingButton>
    </form>
  );
}
