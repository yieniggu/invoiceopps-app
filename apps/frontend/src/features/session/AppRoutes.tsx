import { Navigate, Route, Routes } from "react-router";

import { PageHeader } from "../../components/PageHeader";
import type { Profile } from "../auth/types";
import { AdminUserScreen } from "../admin/screens/AdminUserScreen";
import { AdminUsersScreen } from "../admin/screens/AdminUsersScreen";
import { CreateUserScreen } from "../admin/screens/CreateUserScreen";
import { DashboardScreen } from "../dashboard/DashboardScreen";
import { AddGroupMembersScreen } from "../groups/screens/AddGroupMembersScreen";
import { BulkGroupPermissionsScreen } from "../groups/screens/BulkGroupPermissionsScreen";
import { CreateGroupScreen } from "../groups/screens/CreateGroupScreen";
import { GroupDetailScreen } from "../groups/screens/GroupDetailScreen";
import { GroupMemberScreen } from "../groups/screens/GroupMemberScreen";
import { GroupMembersScreen } from "../groups/screens/GroupMembersScreen";
import { MyGroupsScreen } from "../groups/screens/MyGroupsScreen";
import { OrganizationGroupsScreen } from "../groups/screens/OrganizationGroupsScreen";
import { InvoiceWorkspace } from "../invoices/InvoiceWorkspace";
import { NotFoundScreen } from "../navigation/NotFoundScreen";
import { paths } from "../navigation/paths";
import { AddOrganizationMemberScreen } from "../orgs/screens/AddOrganizationMemberScreen";
import { BulkOrganizationPermissionsScreen } from "../orgs/screens/BulkOrganizationPermissionsScreen";
import { CreateOrganizationScreen } from "../orgs/screens/CreateOrganizationScreen";
import { OrganizationEditScreen } from "../orgs/screens/OrganizationEditScreen";
import { OrganizationDetailScreen } from "../orgs/screens/OrganizationDetailScreen";
import { OrganizationMemberScreen } from "../orgs/screens/OrganizationMemberScreen";
import { OrganizationMembersScreen } from "../orgs/screens/OrganizationMembersScreen";
import { OrganizationsScreen } from "../orgs/screens/OrganizationsScreen";
import { PoliciesUnavailableScreen } from "../policies/PoliciesUnavailableScreen";
import { ProfileScreen } from "../profile/ProfileScreen";
import { UserProfileScreen } from "../users/screens/UserProfileScreen";
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

/** Facturas needs the confirmed work context before it mounts. */
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
      <Route index element={<Navigate to={paths.dashboard} replace />} />
      <Route
        path="dashboard"
        element={
          <DashboardScreen
            profile={profile}
            contextState={workspace.state}
            onRetry={workspace.retry}
          />
        }
      />
      <Route
        path="invoices"
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
      <Route path="policies" element={<PoliciesUnavailableScreen />} />
      <Route
        path="profile"
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
        path="organizations"
        element={
          <OrganizationsScreen
            profile={profile}
            contextState={workspace.state}
            onRetry={workspace.retry}
          />
        }
      />
      <Route
        path="organizations/new"
        element={<CreateOrganizationScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId"
        element={<OrganizationDetailScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/edit"
        element={<OrganizationEditScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/members"
        element={<OrganizationMembersScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/members/new"
        element={<AddOrganizationMemberScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/members/permissions"
        element={<BulkOrganizationPermissionsScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/members/:userId"
        element={<OrganizationMemberScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups"
        element={<OrganizationGroupsScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/new"
        element={<CreateGroupScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/:groupId"
        element={<GroupDetailScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/:groupId/members"
        element={<GroupMembersScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/:groupId/members/new"
        element={<AddGroupMembersScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/:groupId/members/permissions"
        element={<BulkGroupPermissionsScreen profile={profile} />}
      />
      <Route
        path="organizations/:organizationId/groups/:groupId/members/:userId"
        element={<GroupMemberScreen profile={profile} />}
      />
      <Route
        path="users/:userId"
        element={<UserProfileScreen profile={profile} />}
      />
      <Route
        path="groups"
        element={
          <MyGroupsScreen
            profile={profile}
            contextState={workspace.state}
            onRetryContext={workspace.retry}
          />
        }
      />
      <Route
        path="change-password"
        element={<Navigate to={paths.dashboard} replace />}
      />
      <Route
        path="admin/*"
        element={
          // Only the platform administrator reaches /admin; anyone else gets
          // the same page as for any unknown URL.
          profile.isPlatformAdministrator ? (
            <Routes>
              <Route index element={<AdminUsersScreen />} />
              <Route path="users/new" element={<CreateUserScreen />} />
              <Route path="users/:userId" element={<AdminUserScreen />} />
              <Route path="*" element={<NotFoundScreen />} />
            </Routes>
          ) : (
            <NotFoundScreen />
          )
        }
      />
      <Route path="*" element={<NotFoundScreen />} />
    </Routes>
  );
}
