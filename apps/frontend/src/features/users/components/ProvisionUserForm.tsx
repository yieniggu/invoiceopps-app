import { useId, useRef, useState, type FormEvent } from "react";

import { FieldMessage } from "../../../components/FieldMessage";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { RutField } from "../../../components/RutField";
import { isValidRut, toApiRut } from "../../../lib/rut";
import type { OrganizationRole } from "../../auth/types";
import { useProvisionUser } from "../hooks/useUsers";
import { usePresentIssuedCredential } from "./IssuedCredentialProvider";

export function ProvisionUserForm({
  organizationId,
}: {
  organizationId: string;
}) {
  const present = usePresentIssuedCredential();
  const submitButton = useRef<HTMLButtonElement>(null);
  const provision = useProvisionUser(organizationId, (credential) =>
    present(credential, submitButton),
  );
  const [name, setName] = useState("");
  const [rut, setRut] = useState("");
  const [role, setRole] = useState<OrganizationRole>("USER");
  const [submitted, setSubmitted] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const rutInput = useRef<HTMLInputElement>(null);
  const nameMessage = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (provision.isPending) return;
    setSubmitted(true);
    // Values are captured now; typing during the request cannot change them.
    const values = { name: name.trim(), rut, role };
    setNameMissing(!values.name);
    if (!values.name) {
      nameInput.current?.focus();
      return;
    }
    if (!isValidRut(values.rut)) {
      rutInput.current?.focus();
      return;
    }
    provision.mutate(
      { name: values.name, rut: toApiRut(values.rut), role: values.role },
      {
        onSuccess: () => {
          setName("");
          setRut("");
          setRole("USER");
          setSubmitted(false);
        },
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate aria-labelledby="provision-user-title">
      <h2 id="provision-user-title">Crear usuario nuevo</h2>
      <p>
        Se genera una contraseña temporal que verás una sola vez; la persona
        deberá cambiarla al iniciar sesión.
      </p>
      <label>
        Nombre completo
        <input
          ref={nameInput}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameMissing(false);
          }}
          disabled={provision.isPending}
          aria-invalid={nameMissing}
          aria-describedby={nameMessage}
          required
        />
      </label>
      <FieldMessage
        id={nameMessage}
        text={nameMissing ? "Ingresa el nombre completo." : ""}
      />
      <RutField
        label="RUT del usuario"
        missingMessage="Ingresa el RUT"
        value={rut}
        onChange={setRut}
        disabled={provision.isPending}
        submitted={submitted}
        inputRef={rutInput}
        required
      />
      <label>
        Rol del usuario
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as OrganizationRole)}
          disabled={provision.isPending}
        >
          <option value="USER">Usuario</option>
          <option value="ADMIN">Administrador</option>
        </select>
      </label>
      <button ref={submitButton} type="submit" disabled={provision.isPending}>
        {provision.isPending ? "Creando usuario..." : "Crear usuario"}
      </button>
      <MutationFeedback
        isError={provision.isError}
        error={provision.error}
        isSuccess={provision.isSuccess}
        success="Usuario creado. Entrega la contraseña temporal que se muestra."
        fallback="No fue posible crear el usuario. Revisa los datos e intenta nuevamente."
      />
    </form>
  );
}
