import { useState } from "react";

import { MutationFeedback } from "../../../components/MutationFeedback";
import { QueryFeedback } from "../../../components/QueryFeedback";
import { MemberPermissionsEditor } from "../../permissions/components/MemberPermissionsEditor";
import {
  NO_PERMISSIONS,
  type InvoicePermissions,
} from "../../permissions/types";
import { useAddGroupMember, useGroupsQuery } from "../hooks/useGroups";

/** Adds one organization member to a group they are not in yet. */
export function AddToGroupForm({
  organizationId,
  userId,
  userName,
  currentGroupIds,
}: {
  organizationId: string;
  userId: string;
  userName: string;
  /** Groups the person already belongs to here. */
  currentGroupIds: readonly string[];
}) {
  const groups = useGroupsQuery(organizationId);
  const add = useAddGroupMember(organizationId);
  const [chosen, setChosen] = useState("");
  const [permissions, setPermissions] =
    useState<InvoicePermissions>(NO_PERMISSIONS);

  const candidates = (groups.data ?? []).filter(
    ({ id }) => !currentGroupIds.includes(id),
  );
  const selected = candidates.some(({ id }) => id === chosen)
    ? chosen
    : (candidates[0]?.id ?? "");

  return (
    <form
      aria-labelledby="add-to-group-title"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (add.isPending || !selected) return;
        add.mutate(
          { groupId: selected, userId, permissions: { ...permissions } },
          { onSuccess: () => setPermissions(NO_PERMISSIONS) },
        );
      }}
    >
      <h3 id="add-to-group-title">Agregar a un grupo</h3>
      <QueryFeedback
        query={groups}
        loading="Cargando grupos..."
        error="No fue posible cargar los grupos."
        retryLabel="Reintentar grupos"
      />
      {groups.data && candidates.length === 0 ? (
        <p>No hay más grupos en esta organización para agregar a la persona.</p>
      ) : null}
      {candidates.length > 0 ? (
        <>
          <label>
            Grupo
            <select
              value={selected}
              disabled={add.isPending}
              onChange={(event) => setChosen(event.target.value)}
            >
              {candidates.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <MemberPermissionsEditor
            memberName={userName}
            level="group"
            scopeName={candidates.find(({ id }) => id === selected)?.name}
            value={permissions}
            onChange={setPermissions}
            disabled={add.isPending}
            collapsible
            defaultOpen={false}
          />
          <button type="submit" disabled={add.isPending || !selected}>
            {add.isPending ? "Agregando..." : "Agregar al grupo"}
          </button>
        </>
      ) : null}
      <MutationFeedback
        isError={add.isError}
        error={add.error}
        isSuccess={add.isSuccess}
        success="Persona agregada al grupo."
        fallback="No fue posible agregar a la persona al grupo. Intenta nuevamente."
      />
    </form>
  );
}
