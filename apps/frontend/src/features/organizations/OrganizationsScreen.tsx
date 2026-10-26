import { roleLabel, type Profile } from "../profile/ProfileScreen";
import type { Group, GroupsState } from "../groups/GroupsScreen";
import {
  contextValue,
  useSharedWorkspace,
} from "../workspace/WorkspaceContext";

export type PlatformOrganization = {
  id: string;
  name: string;
  groups: Group[];
};
export type PlatformOrganizationsState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "loaded"; organizations: PlatformOrganization[] };

export function PlatformDiscoveryStatus({
  state,
  onRetry,
}: {
  state: PlatformOrganizationsState;
  onRetry: () => void;
}) {
  if (state.kind === "idle" || state.kind === "loading")
    return <p role="status">Cargando organizaciones administrables...</p>;
  if (state.kind === "error")
    return (
      <>
        <p role="alert">No fue posible cargar las organizaciones.</p>
        <button type="button" onClick={onRetry}>
          Reintentar organizaciones
        </button>
      </>
    );
  return null;
}

export function OrganizationsScreen({
  profile,
  discovery,
  contextState,
  onRetry,
}: {
  profile: Profile;
  discovery: PlatformOrganizationsState;
  contextState: GroupsState["kind"];
  onRetry: () => void;
}) {
  const workspace = useSharedWorkspace();
  const external =
    discovery.kind === "loaded"
      ? (discovery.organizations ?? []).filter(
          (organization) =>
            !profile.memberships.some(
              (membership) => membership.organization.id === organization.id,
            ),
        )
      : [];
  return (
    <div className="screen-stack">
      <section aria-labelledby="memberships-title">
        <h2 id="memberships-title">Mis membresías</h2>
        <p>
          Elige una organización para usar tu trabajo individual. Puedes elegir
          un grupo desde Mis grupos.
        </p>
        {profile.memberships.length > 0 ? (
          contextState === "error" ? (
            <>
              <p role="alert">
                No fue posible cargar el contexto de las organizaciones.
              </p>
              <button type="button" onClick={onRetry}>
                Reintentar contexto organizacional
              </button>
            </>
          ) : contextState === "idle" || contextState === "loading" ? (
            <p role="status">Validando contextos de las organizaciones...</p>
          ) : null
        ) : null}
        {profile.memberships.length === 0 ? (
          <p>No tienes organizaciones asignadas.</p>
        ) : (
          <ul className="card-list">
            {profile.memberships.map(({ organization, role }) => {
              const context = workspace.contexts.find(
                (context) =>
                  context.organizationId === organization.id &&
                  context.ownerType === "user" &&
                  context.ownerId === profile.id,
              );
              const active =
                workspace.selectedContext?.organizationId === organization.id;
              return (
                <li key={organization.id} className="context-card">
                  <h3>{organization.name}</h3>
                  <span className="role-badge">({roleLabel(role)})</span>
                  <p>
                    {active
                      ? "Organización del contexto actual"
                      : "Membresía vigente"}
                  </p>
                  <button
                    type="button"
                    disabled={!context}
                    aria-pressed={
                      context
                        ? workspace.selectedValue === contextValue(context)
                        : false
                    }
                    onClick={() => {
                      if (context)
                        workspace.setSelectedValue(contextValue(context));
                    }}
                  >
                    Usar {organization.name}
                  </button>
                  {!context ? (
                    <p>El contexto requiere cargar los grupos vigentes.</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {profile.isPlatformAdministrator ? (
        <section aria-labelledby="platform-title">
          <h2 id="platform-title">Administración de plataforma</h2>
          <p>
            El descubrimiento administrativo no otorga membresía ni acceso a
            Facturas.
          </p>
          <PlatformDiscoveryStatus state={discovery} onRetry={onRetry} />
          {discovery.kind === "loaded" ? (
            external.length > 0 ? (
              <ul className="membership-list">
                {external.map((organization) => (
                  <li key={organization.id}>
                    <strong>{organization.name}</strong>
                    <span>Sin membresía · Solo administración</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                {(discovery.organizations ?? []).length === 0
                  ? "No hay organizaciones disponibles."
                  : "Las organizaciones descubiertas ya figuran en tus membresías."}
              </p>
            )
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
