import { useState } from "react";

import { MutationFeedback } from "../../../components/MutationFeedback";
import { fromApiRut } from "../../../lib/rut";
import { useIdentityId } from "../../auth/hooks/useSession";
import {
  useChangeRole,
  useOrgMembersQuery,
  useRemoveMember,
} from "../hooks/useOrgMembers";
import type { OrganizationRole } from "../types";

const ROLE_OPTIONS: Array<{ value: OrganizationRole; label: string }> = [
  { value: "ADMIN", label: "Administrador" },
  { value: "USER", label: "Usuario" },
];

export function MembersPanel({ organizationId }: { organizationId: string }) {
  const identityId = useIdentityId();
  const members = useOrgMembersQuery(organizationId);
  const changeRole = useChangeRole(organizationId);
  const remove = useRemoveMember(organizationId);
  // Removing a member revokes their group and invoice access: ask first.
  const [confirmingId, setConfirmingId] = useState<string>();
  const busyUser = changeRole.isPending
    ? changeRole.variables.userId
    : remove.isPending
      ? remove.variables.userId
      : undefined;

  return (
    <section aria-labelledby="org-members-title">
      <h2 id="org-members-title">Miembros de la organización</h2>
      {members.isError ? (
        <>
          <p role="alert">
            {members.data
              ? "No fue posible actualizar la lista de miembros. Tus cambios ya se guardaron; no repitas la operación."
              : "No fue posible cargar los miembros."}
          </p>
          <button type="button" onClick={() => void members.refetch()}>
            Reintentar miembros
          </button>
        </>
      ) : null}
      {!members.data ? (
        members.isPending ? (
          <p role="status">Cargando miembros...</p>
        ) : null
      ) : members.data.length === 0 ? (
        <p>Esta organización no tiene miembros.</p>
      ) : (
        <ul className="member-list">
          {members.data.map(({ user, role }) => (
            <li key={user.id}>
              <strong>{user.name}</strong>
              <span>{fromApiRut(user.rut)}</span>
              <select
                aria-label={`Rol de ${user.name}`}
                value={role}
                disabled={busyUser === user.id}
                onChange={(event) => {
                  // The select stays controlled by the server value until the
                  // refetch confirms the change.
                  const next = event.target.value as OrganizationRole;
                  changeRole.mutate({ userId: user.id, role: next });
                }}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {confirmingId === user.id ? (
                <>
                  <button
                    type="button"
                    className="danger-button"
                    autoFocus
                    disabled={busyUser === user.id}
                    onClick={() => {
                      setConfirmingId(undefined);
                      remove.mutate({ userId: user.id });
                    }}
                  >
                    Confirmar quitar a {user.name}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfirmingId(undefined)}
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="danger-button"
                  disabled={busyUser === user.id}
                  onClick={() => setConfirmingId(user.id)}
                >
                  Quitar a {user.name}
                </button>
              )}
              {user.id === identityId ? <span>(tú)</span> : null}
            </li>
          ))}
        </ul>
      )}
      <MutationFeedback
        isError={changeRole.isError}
        error={changeRole.error}
        isSuccess={changeRole.isSuccess}
        success="Rol actualizado."
        fallback="No fue posible cambiar el rol. Intenta nuevamente."
      />
      <MutationFeedback
        isError={remove.isError}
        error={remove.error}
        isSuccess={remove.isSuccess}
        success="Miembro retirado de la organización."
        fallback="No fue posible quitar al miembro. Intenta nuevamente."
      />
    </section>
  );
}
