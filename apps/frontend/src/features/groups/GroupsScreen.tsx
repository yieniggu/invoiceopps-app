import { useEffect, useState, type FormEvent } from "react";
import { fromApiRut } from "../../lib/rut";
import {
  groupMemberTarget,
  type GroupIntent,
  type GroupOperation,
} from "./groupOperations";
import { roleLabel, type Profile } from "../profile/ProfileScreen";
import {
  PlatformDiscoveryStatus,
  type PlatformOrganizationsState,
} from "../organizations/OrganizationsScreen";
import {
  contextValue,
  useSharedWorkspace,
} from "../workspace/WorkspaceContext";
import { protectedFetch } from "../auth/protectedFetch";

export type Group = {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
  members: Array<{ id: string; name: string; rut: string }>;
};
export type GroupsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; groups: Group[] };
export type GroupMutation = (
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  label?: string,
) => void;
type GroupSummary = Omit<Group, "members"> & { members?: Group["members"] };
type Blocked = (
  path: string,
  method: GroupIntent["method"],
  body?: unknown,
) => boolean;

function GroupCard({
  group,
  isAdmin,
  pending,
  onMutate,
  blocked,
}: {
  group: GroupSummary;
  isAdmin: boolean;
  pending: boolean;
  onMutate: GroupMutation;
  blocked?: Blocked;
}) {
  const workspace = useSharedWorkspace();
  const [memberId, setMemberId] = useState("");
  const [removedMemberId, setRemovedMemberId] = useState("");
  const context = workspace.contexts.find(
    (context) =>
      context.ownerType === "group" &&
      context.ownerId === group.id &&
      context.organizationId === group.organization.id,
  );
  const path = `/api/v1/organizations/${group.organization.id}/groups/${group.id}`;
  const addition = groupMemberTarget(path, memberId);
  const removal = groupMemberTarget(path, removedMemberId);
  pending = blocked ? blocked(path, "PATCH") : pending;
  const memberPending =
    pending ||
    !addition ||
    blocked?.(`${path}/members`, "POST", { userId: addition.userId });
  const removalPending =
    pending || !removal || blocked?.(removal.path, "DELETE");
  const submit = (event: FormEvent<HTMLFormElement>, member: boolean) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = member ? groupMemberTarget(path, form.get("userId")) : null;
    if (member && !target) return;
    onMutate(
      member ? `${path}/members` : path,
      member ? "POST" : "PATCH",
      target
        ? { userId: target.userId }
        : { name: form.get("name"), description: form.get("description") },
      member
        ? `Agregando integrante a ${group.name}...`
        : `Guardando grupo ${group.name}...`,
    );
  };
  return (
    <li className="context-card">
      <h3>{group.name}</h3>
      <p>{group.organization.name}</p>
      {group.description ? <p>{group.description}</p> : <p>Sin descripción.</p>}
      {context ? (
        <button
          type="button"
          className="secondary-button"
          aria-pressed={workspace.selectedValue === contextValue(context)}
          disabled={pending}
          onClick={() => workspace.setSelectedValue(contextValue(context))}
        >
          Trabajar con {group.name}
        </button>
      ) : (
        <p>Solo administración; no habilita un contexto de trabajo.</p>
      )}
      <h4>Integrantes</h4>
      {group.members === undefined ? (
        <p>
          Integrantes no consultados. Administra una membresía mediante su UUID
          existente.
        </p>
      ) : group.members.length === 0 ? (
        <p>Este grupo no tiene integrantes.</p>
      ) : (
        <ul className="member-list">
          {group.members.map((member) => {
            const target = groupMemberTarget(path, member.id);
            return (
              <li key={member.id}>
                <span>
                  {member.name} ({fromApiRut(member.rut)})
                </span>
                {isAdmin ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      pending || !target || blocked?.(target.path, "DELETE")
                    }
                    onClick={() =>
                      target &&
                      onMutate(
                        target.path,
                        "DELETE",
                        undefined,
                        `Quitando a ${member.name} de ${group.name}...`,
                      )
                    }
                  >
                    Quitar a {member.name} de {group.name}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {isAdmin ? (
        <div className="screen-stack group-management">
          <form
            onSubmit={(event) => submit(event, false)}
            aria-label={`Editar ${group.name}`}
          >
            <label>
              Editar nombre de {group.name}
              <input
                name="name"
                defaultValue={group.name}
                required
                maxLength={120}
                pattern=".*\S.*"
                disabled={pending}
              />
            </label>
            <label>
              Editar descripción de {group.name}
              <input
                name="description"
                defaultValue={group.description ?? ""}
                maxLength={1000}
                disabled={pending}
              />
            </label>
            <button type="submit" disabled={pending}>
              Guardar grupo {group.name}
            </button>
          </form>
          {group.members === undefined ? (
            <form
              aria-label={`Quitar integrante de ${group.name}`}
              onSubmit={(event) => {
                event.preventDefault();
                const target = groupMemberTarget(
                  path,
                  new FormData(event.currentTarget).get("userId"),
                );
                if (!target) return;
                onMutate(
                  target.path,
                  "DELETE",
                  undefined,
                  `Quitando integrante de ${group.name}...`,
                );
              }}
            >
              <label>
                UUID de integrante para quitar de {group.name}
                <input
                  name="userId"
                  value={removedMemberId}
                  onChange={(event) => setRemovedMemberId(event.target.value)}
                  required
                  pattern="[0-9a-fA-F-]{36}"
                  disabled={pending}
                />
              </label>
              <button type="submit" disabled={removalPending}>
                Quitar integrante de {group.name}
              </button>
            </form>
          ) : null}
          <form
            onSubmit={(event) => submit(event, true)}
            aria-label={`Agregar integrante a ${group.name}`}
          >
            <label>
              ID de integrante para {group.name}
              <input
                name="userId"
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
                required
                pattern=".*\S.*"
                disabled={pending}
              />
            </label>
            <p>
              La persona debe tener una membresía vigente en esta organización.
            </p>
            <button type="submit" disabled={memberPending}>
              Agregar integrante a {group.name}
            </button>
          </form>
          <div className="destructive-action">
            <p>Eliminar el grupo también retira sus integrantes del grupo.</p>
            <button
              type="button"
              className="danger-button"
              disabled={pending}
              onClick={() =>
                onMutate(
                  path,
                  "DELETE",
                  undefined,
                  `Eliminando grupo ${group.name}...`,
                )
              }
            >
              Eliminar grupo {group.name}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function GroupsScreen({
  profile,
  state,
  discovery,
  pending,
  operation,
  error,
  message,
  onRetry,
  onMutate,
  blocked,
  operations = [],
  readRevision = 0,
  sessionEpoch = 0,
  onUnauthorized,
}: {
  profile: Profile;
  state: GroupsState;
  discovery: PlatformOrganizationsState;
  pending: boolean;
  operation?: string;
  error?: string;
  message?: string;
  onRetry: () => void;
  onMutate: GroupMutation;
  blocked?: Blocked;
  operations?: GroupOperation[];
  readRevision?: number;
  sessionEpoch?: number;
  onUnauthorized?: () => void;
}) {
  // Only GET /groups supplies membership groups. Discovery never supplies selectable owners.
  const localGroups =
    state.kind === "loaded"
      ? state.groups.filter((group) =>
          profile.memberships.some(
            ({ organization }) => organization.id === group.organization.id,
          ),
        )
      : [];
  const discoveredGroups =
    discovery.kind === "loaded"
      ? (discovery.organizations ?? [])
          .flatMap((organization) => organization.groups)
          .filter(
            (group) => !localGroups.some((local) => local.id === group.id),
          )
      : [];
  const creationOrganizations =
    profile.isPlatformAdministrator && discovery.kind === "loaded"
      ? (discovery.organizations ?? [])
      : profile.memberships
          .filter(({ role }) => role === "ADMIN")
          .map(({ organization }) => organization);
  return (
    <div className="screen-stack">
      <section aria-labelledby="groups-title">
        <h2 id="groups-title">Grupos de mis membresías</h2>
        <p>
          Los grupos a los que perteneces permiten compartir el contexto de
          Facturas.
        </p>
        {state.kind === "idle" || state.kind === "loading" ? (
          <p role="status">Cargando grupos...</p>
        ) : state.kind === "error" ? (
          <>
            <p role="alert">No fue posible cargar los grupos.</p>
            <button type="button" disabled={pending} onClick={onRetry}>
              Reintentar grupos
            </button>
          </>
        ) : localGroups.length === 0 ? (
          <p>No perteneces a grupos todavía.</p>
        ) : (
          <ul className="card-list">
            {localGroups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                isAdmin={
                  profile.isPlatformAdministrator ||
                  profile.memberships.some(
                    ({ organization, role }) =>
                      organization.id === group.organization.id &&
                      role === "ADMIN",
                  )
                }
                pending={pending}
                blocked={blocked}
                onMutate={onMutate}
              />
            ))}
          </ul>
        )}
        {profile.memberships.length > 0 ? (
          <p className="membership-roles">
            {profile.memberships
              .map(
                ({ organization, role }) =>
                  `${organization.name}: ${roleLabel(role)}`,
              )
              .join(" · ")}
          </p>
        ) : null}
      </section>
      {profile.isPlatformAdministrator ? (
        <section aria-labelledby="managed-groups-title">
          <h2 id="managed-groups-title">Grupos administrables</h2>
          <p>
            La administración de grupos no otorga acceso a su trabajo ni
            incorpora integrantes automáticamente.
          </p>
          <PlatformDiscoveryStatus state={discovery} onRetry={onRetry} />
          {discovery.kind === "loaded" && state.kind === "loaded" ? (
            discoveredGroups.length > 0 ? (
              <ul className="card-list">
                {discoveredGroups.map((group) => (
                  <GroupCard
                    key={group.id}
                    group={group}
                    isAdmin
                    pending={pending}
                    blocked={blocked}
                    onMutate={onMutate}
                  />
                ))}
              </ul>
            ) : (
              <p>
                No hay grupos adicionales en las organizaciones administrables.
              </p>
            )
          ) : null}
        </section>
      ) : null}
      {!profile.isPlatformAdministrator && creationOrganizations.length > 0 ? (
        <GroupCatalog
          organizations={creationOrganizations}
          localGroups={localGroups}
          blocked={blocked}
          onMutate={onMutate}
          revision={readRevision}
          sessionEpoch={sessionEpoch}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {creationOrganizations.length > 0 ? (
        <section aria-labelledby="create-group-title">
          <h2 id="create-group-title">Crear grupo</h2>
          <div className="screen-grid">
            {creationOrganizations.map((organization) => (
              <form
                key={organization.id}
                aria-label={`Crear grupo en ${organization.name}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  onMutate(
                    `/api/v1/organizations/${organization.id}/groups`,
                    "POST",
                    { name: new FormData(event.currentTarget).get("name") },
                    `Creando grupo en ${organization.name}...`,
                  );
                }}
              >
                <h3>{organization.name}</h3>
                <label>
                  Nuevo grupo en {organization.name}
                  <input
                    name="name"
                    required
                    maxLength={120}
                    pattern=".*\S.*"
                    disabled={
                      blocked
                        ? blocked(
                            `/api/v1/organizations/${organization.id}/groups`,
                            "POST",
                          )
                        : pending
                    }
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    blocked
                      ? blocked(
                          `/api/v1/organizations/${organization.id}/groups`,
                          "POST",
                        )
                      : pending
                  }
                >
                  Crear grupo en {organization.name}
                </button>
              </form>
            ))}
          </div>
        </section>
      ) : null}
      {operations.some(
        (operation) =>
          operation.kind === "confirmed" && operation.refreshFailed,
      ) ? (
        <p role="status">
          Operación de grupo confirmada. Falta actualizar las consultas; usa
          Reintentar grupos y no repitas la escritura.
        </p>
      ) : null}
      {operations
        .filter((operation) => operation.kind === "unknown")
        .map((operation) => (
          <p role="alert" key={operation.key}>
            El resultado es desconocido:{" "}
            {operation.intent.label ?? operation.intent.path}{" "}
            {operation.memberId ? (
              <span>Integrante: {operation.memberId}. </span>
            ) : null}
            No repitas esta operación. Conservamos el bloqueo durante esta
            sesión; solicita verificación operativa. Consultar listas no
            confirma su resultado. Recargar la aplicación o iniciar otra sesión
            pierde esta protección en memoria.
          </p>
        ))}
      {pending ? (
        <p role="status">{operation ?? "Actualizando grupos..."}</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : message ? (
        <p role="status">{message}</p>
      ) : null}
    </div>
  );
}

function GroupCatalog({
  organizations,
  localGroups,
  blocked,
  onMutate,
  revision,
  sessionEpoch,
  onUnauthorized,
}: {
  organizations: Array<{ id: string; name: string }>;
  localGroups: Group[];
  blocked?: Blocked;
  onMutate: GroupMutation;
  revision: number;
  sessionEpoch: number;
  onUnauthorized?: () => void;
}) {
  const [organizationId, setOrganizationId] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    organizationId: string;
    groups: GroupSummary[];
    nextCursor: string | null;
  }>();
  const [status, setStatus] = useState("idle");
  const authorized = organizations.some((org) => org.id === organizationId);
  useEffect(() => {
    if (!authorized) return;
    let current = true;
    setStatus("loading");
    void (async () => {
      try {
        const query = new URLSearchParams({
          limit: "50",
          ...(cursor ? { cursor } : {}),
        });
        const response = await protectedFetch(
          `/api/v1/organizations/${encodeURIComponent(organizationId)}/groups?${query}`,
          { credentials: "same-origin" },
        );
        if (!current) return;
        if (response.status === 401) {
          onUnauthorized?.();
          return;
        }
        if (!response.ok) throw new Error("Group catalog read failed");
        const page = (await response.json()) as {
          groups: GroupSummary[];
          nextCursor: string | null;
        };
        if (!current) return;
        setResult({ ...page, organizationId });
        setStatus("loaded");
      } catch {
        if (current) setStatus("error");
      }
    })();
    return () => {
      current = false;
    };
  }, [
    organizationId,
    authorized,
    cursor,
    retry,
    revision,
    sessionEpoch,
    onUnauthorized,
  ]);
  return (
    <section aria-labelledby="catalog-title">
      <h2 id="catalog-title">Catálogo administrativo de grupos</h2>
      <p>
        Este catálogo no concede acceso al trabajo ni consulta datos personales
        de integrantes.
      </p>
      <label>
        Organización del catálogo de grupos
        <select
          value={authorized ? organizationId : ""}
          onChange={(event) => {
            setOrganizationId(event.target.value);
            setCursor(undefined);
            setResult(undefined);
          }}
        >
          <option value="">Selecciona una organización</option>
          {organizations.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      {authorized && status === "loading" ? (
        <p role="status">Cargando catálogo...</p>
      ) : null}
      {authorized && status === "error" ? (
        <>
          <p role="alert">No fue posible consultar el catálogo.</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Reintentar catálogo
          </button>
        </>
      ) : null}
      {authorized &&
      status === "loaded" &&
      result?.organizationId === organizationId ? (
        <>
          <ul className="card-list">
            {result.groups
              .filter(
                (group) => !localGroups.some((local) => local.id === group.id),
              )
              .map((group) => (
                <GroupCard
                  key={group.id}
                  group={group}
                  isAdmin
                  pending={false}
                  blocked={blocked}
                  onMutate={onMutate}
                />
              ))}
          </ul>
          {result.groups.length === 0 ? (
            <p>No hay grupos en esta página.</p>
          ) : null}
          {result.nextCursor ? (
            <button
              type="button"
              onClick={() => setCursor(result.nextCursor ?? undefined)}
            >
              Página siguiente del catálogo
            </button>
          ) : null}
          {cursor ? (
            <button type="button" onClick={() => setCursor(undefined)}>
              Volver al inicio del catálogo
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
