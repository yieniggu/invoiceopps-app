import { useRef, useState, type FormEvent } from "react";

import { MutationFeedback } from "../../../components/MutationFeedback";
import { RutField } from "../../../components/RutField";
import { isValidRut, toApiRut } from "../../../lib/rut";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import {
  NO_PERMISSIONS,
  type InvoicePermissions,
} from "../../permissions/types";
import { useAssignMember } from "../hooks/useOrgMembers";
import type { OrganizationRole } from "../types";
import { memberRoleLabel } from "../types/roles";

/** Assigns an existing person by exact RUT; it never lists a global directory. */
export function AssignMemberForm({
  organizationId,
  onAssigned,
}: {
  organizationId: string;
  /** Called once the person was added; the screen decides where to go next. */
  onAssigned: () => void;
}) {
  const assign = useAssignMember(organizationId);
  const [rut, setRut] = useState("");
  const [role, setRole] = useState<OrganizationRole>("USER");
  const [permissions, setPermissions] =
    useState<InvoicePermissions>(NO_PERMISSIONS);
  const [submitted, setSubmitted] = useState(false);
  const rutInput = useRef<HTMLInputElement>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (assign.isPending) return;
    setSubmitted(true);
    const values = { rut, role, permissions: { ...permissions } };
    if (!isValidRut(values.rut)) {
      rutInput.current?.focus();
      return;
    }
    assign.mutate(
      {
        rut: toApiRut(values.rut),
        role: values.role,
        permissions: values.permissions,
      },
      { onSuccess: onAssigned },
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby="assign-member-title">
      <h2 id="assign-member-title">Agregar persona existente</h2>
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
          <option value="USER">{memberRoleLabel("USER")}</option>
          <option value="ADMIN">{memberRoleLabel("ADMIN")}</option>
        </select>
      </label>
      <MemberPermissionsEditor
        memberName="la persona a asignar"
        level="organization"
        value={permissions}
        onChange={setPermissions}
        disabled={assign.isPending}
      />
      <button type="submit" disabled={assign.isPending}>
        {assign.isPending ? "Agregando..." : "Agregar persona"}
      </button>
      <MutationFeedback
        isError={assign.isError}
        error={assign.error}
        isSuccess={false}
        success=""
        fallback="No fue posible asignar a la persona. Intenta nuevamente."
      />
    </form>
  );
}
