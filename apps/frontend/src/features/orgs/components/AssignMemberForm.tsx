import { useRef, useState, type FormEvent } from "react";

import { MutationFeedback } from "../../../components/MutationFeedback";
import { RutField } from "../../../components/RutField";
import { isValidRut, toApiRut } from "../../../lib/rut";
import { useAssignMember } from "../hooks/useOrgMembers";
import type { OrganizationRole } from "../types";

/** Assigns an existing person by exact RUT; it never lists a global directory. */
export function AssignMemberForm({
  organizationId,
}: {
  organizationId: string;
}) {
  const assign = useAssignMember(organizationId);
  const [rut, setRut] = useState("");
  const [role, setRole] = useState<OrganizationRole>("USER");
  const [submitted, setSubmitted] = useState(false);
  const rutInput = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (assign.isPending) return;
    setSubmitted(true);
    const values = { rut, role };
    if (!isValidRut(values.rut)) {
      rutInput.current?.focus();
      return;
    }
    assign.mutate(
      { rut: toApiRut(values.rut), role: values.role },
      {
        onSuccess: () => {
          setRut("");
          setRole("USER");
          setSubmitted(false);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby="assign-member-title">
      <h2 id="assign-member-title">Asignar persona existente</h2>
      <RutField
        label="RUT de la persona"
        missingMessage="Ingresa el RUT"
        value={rut}
        onChange={setRut}
        disabled={assign.isPending}
        submitted={submitted}
        inputRef={rutInput}
        required
      />
      <label>
        Rol a asignar
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as OrganizationRole)}
          disabled={assign.isPending}
        >
          <option value="USER">Usuario</option>
          <option value="ADMIN">Administrador</option>
        </select>
      </label>
      <button type="submit" disabled={assign.isPending}>
        {assign.isPending ? "Asignando..." : "Asignar persona"}
      </button>
      <MutationFeedback
        isError={assign.isError}
        error={assign.error}
        isSuccess={assign.isSuccess}
        success="Persona asignada a la organización."
        fallback="No fue posible asignar a la persona. Intenta nuevamente."
      />
    </form>
  );
}
