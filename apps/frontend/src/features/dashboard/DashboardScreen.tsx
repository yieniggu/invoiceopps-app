import type { ReactNode } from "react";
import {
  Briefcase,
  ReceiptText,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

import { LinkButton } from "../../components/LinkButton";
import { PageHeader } from "../../components/PageHeader";
import type { Profile } from "../profile/ProfileScreen";
import { hasInvoiceAccess } from "../invoices/invoiceScopes";
import { paths } from "../navigation/paths";
import type { ContextState } from "../workspace/useWorkspaceGroups";
import { useSharedWorkspace } from "../workspace/WorkspaceContext";

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
  actions?: ReactNode;
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
      {actions ? (
        <div className="dash-card-actions action-row">{actions}</div>
      ) : null}
    </section>
  );
}

export function DashboardScreen({
  profile,
  contextState,
  onRetry,
}: {
  profile: Profile;
  contextState: ContextState;
  onRetry: () => void;
}) {
  const { selectedContext } = useSharedWorkspace();
  return (
    <div className="screen-stack">
      <PageHeader
        title="Panel principal"
        description={`Bienvenido, ${profile.name}. Elige por dónde empezar.`}
      />
      <div className="dash-grid">
        {hasInvoiceAccess(profile) ? (
          <DashboardCard
            id="dashboard-invoices-title"
            icon={ReceiptText}
            title="Facturas"
            featured
            actions={<LinkButton to={paths.invoices}>Ir a facturas</LinkButton>}
          >
            <p>
              Revisa las facturas a las que tienes acceso y abre su detalle.
            </p>
          </DashboardCard>
        ) : null}
        <DashboardCard
          id="dashboard-context-title"
          icon={Briefcase}
          title="Tu espacio de trabajo"
          actions={
            <>
              <LinkButton to={paths.organizations}>
                Ver mis organizaciones
              </LinkButton>
              <LinkButton to={paths.groups} variant="secondary">
                Ver mis grupos
              </LinkButton>
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
        >
          <p>Próximamente.</p>
        </DashboardCard>
      </div>
    </div>
  );
}
