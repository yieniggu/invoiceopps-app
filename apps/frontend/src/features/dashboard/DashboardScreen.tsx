import type { ReactNode } from "react";
import {
  Briefcase,
  ReceiptText,
  ShieldCheck,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import type { Profile } from "../profile/ProfileScreen";
import type { Destination } from "../navigation/AppShell";
import type { GroupsState } from "../groups/GroupsScreen";
import { useSharedWorkspace } from "../workspace/WorkspaceContext";
import { canAdministrate } from "../admin/administrationOperations";

function DashboardCard({
  id,
  icon: Icon,
  title,
  featured = false,
  actions,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  featured?: boolean;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={featured ? "dash-card dash-card-featured" : "dash-card"}
    >
      <span className="dash-card-icon" aria-hidden="true">
        <Icon focusable="false" size={featured ? 28 : 24} />
      </span>
      <h2 id={id}>{title}</h2>
      <div className="dash-card-body">{children}</div>
      <div className="dash-card-actions action-row">{actions}</div>
    </section>
  );
}

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
      <p className="page-intro">
        Bienvenido, {profile.name}. Elige por dónde empezar.
      </p>
      <div className="dash-grid">
        <DashboardCard
          id="dashboard-invoices-title"
          icon={ReceiptText}
          title="Facturas"
          featured
          actions={
            <button type="button" onClick={() => onNavigate("Facturas")}>
              Ir a facturas
            </button>
          }
        >
          <p>
            Revisa las facturas de tu organización o grupo activo y abre su
            detalle.
          </p>
        </DashboardCard>
        <DashboardCard
          id="dashboard-context-title"
          icon={Briefcase}
          title="Tu espacio de trabajo"
          actions={
            <>
              <button
                type="button"
                onClick={() => onNavigate("Organizaciones")}
              >
                Ver mis organizaciones
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => onNavigate("Mis grupos")}
              >
                Ver mis grupos
              </button>
            </>
          }
        >
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
            <p>Elige una organización o grupo para empezar.</p>
          )}
        </DashboardCard>
        <DashboardCard
          id="dashboard-policies-title"
          icon={SlidersHorizontal}
          title="Políticas"
          actions={
            <button type="button" onClick={() => onNavigate("Políticas")}>
              Ir a políticas
            </button>
          }
        >
          <p>
            Consulta y versiona los umbrales de revisión de tu organización o
            grupo.
          </p>
        </DashboardCard>
        {canAdministrate(profile) ? (
          <DashboardCard
            id="dashboard-admin-title"
            icon={ShieldCheck}
            title="Administración"
            actions={
              <button
                type="button"
                onClick={() => onNavigate("Administración")}
              >
                Ir a administración
              </button>
            }
          >
            <p>
              Crea organizaciones, aprovisiona usuarios y gestiona grupos y
              membresías.
            </p>
          </DashboardCard>
        ) : null}
      </div>
    </div>
  );
}
