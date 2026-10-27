import { useState } from "react";

import { MutationFeedback } from "../../../components/MutationFeedback";
import { fromApiRut } from "../../../lib/rut";
import { useOrgUsersQuery } from "../../users/hooks/useUsers";
import {
  useAddGroupMember,
  useGroupMembersQuery,
  useRemoveGroupMember,
} from "../hooks/useGroups";
import type { Group } from "../types";

/** Membership only: adding or removing people, never their permissions. */
export function GroupMembersPanel({
  organizationId,
  group,
}: {
  organizationId: string;
  group: Group;
}) {
  const members = useGroupMembersQuery(organizationId, group.id);
  const users = useOrgUsersQuery(organizationId);
  const add = useAddGroupMember(organizationId, group.id);
  const remove = useRemoveGroupMember(organizationId, group.id);
  const [chosen, setChosen] = useState("");

  const memberIds = new Set((members.data ?? []).map(({ userId }) => userId));
  const candidates = (users.data ?? []).filter(({ id }) => !memberIds.has(id));
  const selected = candidates.some(({ id }) => id === chosen)
    ? chosen
    : (candidates[0]?.id ?? "");

  return (
    <section aria-labelledby={`group-members-${group.id}`}>
      <h2 id={`group-members-${group.id}`}>Miembros de {group.name}</h2>
      {members.isError ? (
        <>
          <p role="alert">
            {members.data
              ? "No fue posible actualizar los miembros del grupo. Tus cambios ya se guardaron; no repitas la operación."
              : "No fue posible cargar los miembros del grupo."}
          </p>
          <button type="button" onClick={() => void members.refetch()}>
            Reintentar miembros del grupo
          </button>
        </>
      ) : null}
      {!members.data ? (
        members.isPending ? (
          <p role="status">Cargando miembros del grupo...</p>
        ) : null
      ) : members.data.length === 0 ? (
        <p>Este grupo no tiene miembros.</p>
      ) : (
        <ul className="member-list">
          {members.data.map(({ user }) => (
            <li key={user.id}>
              <strong>{user.name}</strong>
              <span>{fromApiRut(user.rut)}</span>
              <button
                type="button"
                className="danger-button"
                disabled={remove.isPending}
                onClick={() => remove.mutate({ userId: user.id })}
              >
                Quitar a {user.name} del grupo
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (add.isPending || !selected) return;
          add.mutate({ userId: selected });
        }}
      >
        <label>
          Persona a agregar
          <select
            value={selected}
            disabled={add.isPending || candidates.length === 0}
            onChange={(event) => setChosen(event.target.value)}
          >
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        {users.isSuccess && candidates.length === 0 ? (
          <p>No hay más personas de la organización para agregar.</p>
        ) : null}
        <button type="submit" disabled={add.isPending || !selected}>
          {add.isPending ? "Agregando..." : "Agregar al grupo"}
        </button>
      </form>
      <MutationFeedback
        isError={add.isError}
        error={add.error}
        isSuccess={add.isSuccess}
        success="Persona agregada al grupo."
        fallback="No fue posible agregar a la persona. Intenta nuevamente."
      />
      <MutationFeedback
        isError={remove.isError}
        error={remove.error}
        isSuccess={remove.isSuccess}
        success="Persona quitada del grupo."
        fallback="No fue posible quitar a la persona. Intenta nuevamente."
      />
    </section>
  );
}
