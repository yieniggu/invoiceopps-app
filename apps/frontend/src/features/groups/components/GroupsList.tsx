import { useGroupsQuery } from "../hooks/useGroups";
import type { GroupMembershipProfile } from "../../auth/types";
import { GroupRow } from "./GroupRow";

/** Groups of one organization: all for an ADMIN, only own groups for a USER. */
export function GroupsList({
  organizationId,
  isAdmin,
  memberGroups = [],
}: {
  organizationId: string;
  isAdmin: boolean;
  /** My own group memberships here, for the effective-permission summary. */
  memberGroups?: GroupMembershipProfile[];
}) {
  const groups = useGroupsQuery(organizationId);
  return (
    <>
      {groups.isError ? (
        <>
          <p role="alert">
            {groups.data
              ? "No fue posible actualizar la lista de grupos. Tus cambios ya se guardaron; no repitas la operación."
              : "No fue posible cargar los grupos."}
          </p>
          <button type="button" onClick={() => void groups.refetch()}>
            Reintentar grupos
          </button>
        </>
      ) : null}
      {!groups.data ? (
        groups.isPending ? (
          <p role="status">Cargando grupos...</p>
        ) : null
      ) : groups.data.length === 0 ? (
        <p>
          {isAdmin
            ? "Esta organización aún no tiene grupos. Crea el primero con «Crear grupo»."
            : "No perteneces a ningún grupo de esta organización todavía."}
        </p>
      ) : (
        <ul className="card-grid">
          {groups.data.map((group) => (
            <GroupRow
              key={group.id}
              organizationId={organizationId}
              group={group}
              effective={
                memberGroups.find((entry) => entry.group.id === group.id)
                  ?.effective
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}
