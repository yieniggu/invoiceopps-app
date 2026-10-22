import type { Profile } from "../profile/ProfileScreen";
import type { Destination } from "../navigation/AppShell";
import type { GroupsState } from "../groups/GroupsScreen";
import { useSharedWorkspace } from "../workspace/WorkspaceContext";
import { canAdministrate } from "../admin/administrationOperations";

export function DashboardScreen({
  profile,
  contextState,
  onNavigate,
  onRetry,
}: {
  profile: Profile;
  contextState: GroupsState["kind"];
  onNavigate: (destination: Destination) => void;
  onRetry: () => void;
}) {
  const { selectedContext } = useSharedWorkspace();
  return (
    <div className="screen-stack">
      <section aria-labelledby="welcome-title" className="dashboard-intro">
        <h2 id="welcome-title">Bienvenido, {profile.name}</h2>
        <p>Organiza tu trabajo individual o grupal desde un mismo lugar.</p>
      </section>
      <section aria-labelledby="dashboard-context-title">
        <h2 id="dashboard-context-title">Tu espacio de trabajo</h2>
        {profile.memberships.length > 0 &&
        (contextState === "idle" || contextState === "loading") ? (
          <p role="status">Validando tu espacio de trabajo...</p>
        ) : contextState === "error" ? (
          <>
            <p role="alert">No fue posible validar tu espacio de trabajo.</p>
            <button type="button" onClick={onRetry}>
              Reintentar espacio de trabajo
            </button>
          </>
        ) : selectedContext ? (
          <dl className="context-details">
            <div>
              <dt>Organización activa</dt>
              <dd>{selectedContext.organizationName}</dd>
            </div>
            <div>
              <dt>Modalidad</dt>
              <dd>
                {selectedContext.ownerType === "group"
                  ? `Grupo: ${selectedContext.ownerName}`
                  : "Trabajo individual"}
              </dd>
            </div>
          </dl>
        ) : (
          <p>No tienes un contexto de trabajo activo.</p>
        )}
        <div className="action-row">
          <button type="button" onClick={() => onNavigate("Organizaciones")}>
            Ver mis organizaciones
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => onNavigate("Mis grupos")}
          >
            Ver mis grupos
          </button>
        </div>
      </section>
      <div className="screen-grid">
        {canAdministrate(profile) ? (
          <section aria-labelledby="dashboard-admin-title">
            <h2 id="dashboard-admin-title">Administración</h2>
            <p>
              Gestiona grupos y, con autoridad de plataforma, membresías
              organizacionales.
            </p>
            <button type="button" onClick={() => onNavigate("Administración")}>
              Abrir administración
            </button>
          </section>
        ) : null}
        <section aria-labelledby="dashboard-evidence-title">
          <h2 id="dashboard-evidence-title">Evidencia y lotes</h2>
          <p>
            Consulta registros, lotes y pruebas Merkle existentes sin crear ni
            anclar evidencia.
          </p>
          <button type="button" onClick={() => onNavigate("Evidencia y lotes")}>
            Abrir evidencia y lotes
          </button>
        </section>
        <section aria-labelledby="dashboard-policies-title">
          <h2 id="dashboard-policies-title">Políticas</h2>
          <p>
            Consulta las versiones y configura el umbral de revisión manual
            según los permisos de tu contexto.
          </p>
          <button type="button" onClick={() => onNavigate("Políticas")}>
            Abrir políticas
          </button>
        </section>
        <section aria-labelledby="dashboard-invoices-title">
          <h2 id="dashboard-invoices-title">Facturas</h2>
          <p>
            Consulta el listado, el detalle y las acciones disponibles para el
            contexto elegido.
          </p>
          <button type="button" onClick={() => onNavigate("Facturas")}>
            Abrir facturas
          </button>
        </section>
        <section aria-labelledby="dashboard-resources-title">
          <h2 id="dashboard-resources-title">Recursos</h2>
          <p>
            Consulta las referencias y los recursos de MLflow de tu espacio de
            trabajo.
          </p>
          <button type="button" onClick={() => onNavigate("Recursos")}>
            Abrir recursos
          </button>
        </section>
      </div>
    </div>
  );
}
