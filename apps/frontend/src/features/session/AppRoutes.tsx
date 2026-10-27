import { Navigate, Route, Routes } from "react-router";

import { PageHeader } from "../../components/PageHeader";
import type { Profile } from "../auth/types";
import { DashboardScreen } from "../dashboard/DashboardScreen";
import { MyGroupsScreen } from "../groups/screens/MyGroupsScreen";
import { CreateGroupScreen } from "../groups/screens/CreateGroupScreen";
import { GroupDetailScreen } from "../groups/screens/GroupDetailScreen";
import { OrganizationGroupsScreen } from "../groups/screens/OrganizationGroupsScreen";
import { InvoiceWorkspace } from "../invoices/InvoiceWorkspace";
import { NotFoundScreen } from "../navigation/NotFoundScreen";
import { paths } from "../navigation/paths";
import { CreateOrganizationScreen } from "../orgs/screens/CreateOrganizationScreen";
import { OrganizationDetailScreen } from "../orgs/screens/OrganizationDetailScreen";
import { OrganizationsScreen } from "../orgs/screens/OrganizationsScreen";
import { PoliciesScreen } from "../policies/PoliciesScreen";
import { ProfileScreen } from "../profile/ProfileScreen";
import { WorkspaceBoundary } from "../workspace/WorkspaceContext";
import type {
  ContextState,
  WorkspaceGroup,
} from "../workspace/useWorkspaceGroups";

export interface WorkspaceState {
  state: ContextState;
  groups: WorkspaceGroup[] | undefined;
  retry: () => void;
}

/** Facturas and Políticas need the confirmed work context before they mount. */
function WorkspaceRoute({
  title,
  description,
  workspace,
  children,
}: {
  title: string;
  description: string;
  workspace: WorkspaceState;
  children: (groups: WorkspaceGroup[]) => React.ReactNode;
}) {
  const { state, groups, retry } = workspace;
  return (
    <div className="screen-stack">
      <PageHeader title={title} description={description} />
      {state === "loaded" && groups ? (
        <WorkspaceBoundary>{children(groups)}</WorkspaceBoundary>
      ) : state === "error" ? (
        <>
          <p role="alert">No fue posible cargar el contexto de trabajo.</p>
          <button type="button" onClick={retry}>
            Reintentar contexto
          </button>
        </>
      ) : (
        <p role="status">Cargando contexto de trabajo...</p>
      )}
    </div>
  );
}

/** URL table of everything a person with a settled password can reach. */
export function AppRoutes({
  profile,
  workspace,
}: {
  profile: Profile;
  workspace: WorkspaceState;
}) {
  return (
    <Routes>
      <Route index element={<Navigate to={paths.panel} replace />} />
      <Route
        path="panel"
        element={
          <DashboardScreen
            profile={profile}
            contextState={workspace.state}
            onRetry={workspace.retry}
          />
        }
      />
      <Route
        path="facturas"
        element={
          <WorkspaceRoute
            title="Facturas"
            description="Revisa las facturas de tu organización o grupo activo y abre su detalle."
            workspace={workspace}
          >
            {(groups) => <InvoiceWorkspace profile={profile} groups={groups} />}
          </WorkspaceRoute>
        }
      />
      <Route
        path="politicas"
        element={
          <WorkspaceRoute
            title="Políticas"
            description="Consulta y versiona los umbrales de revisión de tu organización o grupo."
            workspace={workspace}
          >
            {() => <PoliciesScreen profile={profile} />}
          </WorkspaceRoute>
        }
      />
      <Route
        path="perfil"
        element={
          <div className="screen-stack">
            <PageHeader
              title="Mi perfil"
              description="Consulta tus datos y actualiza tu información de contacto."
            />
            <ProfileScreen profile={profile} />
          </div>
        }
      />
      <Route
        path="organizaciones"
        element={
          <OrganizationsScreen
            profile={profile}
            contextState={workspace.state}
            onRetry={workspace.retry}
          />
        }
      />
      <Route
        path="organizaciones/nueva"
        element={<CreateOrganizationScreen profile={profile} />}
      />
      <Route
        path="organizaciones/:organizationId"
        element={<OrganizationDetailScreen profile={profile} />}
      />
      <Route
        path="organizaciones/:organizationId/grupos"
        element={<OrganizationGroupsScreen profile={profile} />}
      />
      <Route
        path="organizaciones/:organizationId/grupos/nuevo"
        element={<CreateGroupScreen profile={profile} />}
      />
      <Route
        path="organizaciones/:organizationId/grupos/:groupId"
        element={<GroupDetailScreen profile={profile} />}
      />
      <Route
        path="grupos"
        element={
          <MyGroupsScreen
            profile={profile}
            contextState={workspace.state}
            onRetryContext={workspace.retry}
          />
        }
      />
      <Route
        path="cambiar-contrasena"
        element={<Navigate to={paths.panel} replace />}
      />
      <Route path="*" element={<NotFoundScreen />} />
    </Routes>
  );
}
