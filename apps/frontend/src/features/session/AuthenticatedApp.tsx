import { useLogoutMutation } from "../auth/hooks/useAuthMutations";
import { ProtectedSessionProvider } from "../auth/components/ProtectedSession";
import { useSessionSnapshot, useSessionStore } from "../auth/hooks/useSession";
import type { Profile } from "../auth/types";
import { AppShell } from "../navigation/AppShell";
import { IssuedCredentialProvider } from "../users/components/IssuedCredentialProvider";
import { PolicyMutationsProvider } from "../policies/PolicyMutationsContext";
import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import { useWorkspaceGroups } from "../workspace/useWorkspaceGroups";
import { AppRoutes } from "./AppRoutes";

/** Everything a person with a settled password can reach. */
export function AuthenticatedApp({ profile }: { profile: Profile }) {
  const store = useSessionStore();
  const { client, generation } = useSessionSnapshot();
  const logout = useLogoutMutation();
  const workspace = useWorkspaceGroups(profile);

  const isLoggingOut = logout.isPending;

  return (
    <AppShell onLogout={() => logout.mutate()} isLoggingOut={isLoggingOut}>
      {/* Policies and invoices keep their own fetching; a stale 401 from a
          retired partition is ignored because `end` compares clients. */}
      <ProtectedSessionProvider onUnauthorized={() => store.end(client)}>
        <PolicyMutationsProvider key={profile.id}>
          <WorkspaceProvider
            key={`${generation}:${profile.id}`}
            profile={profile}
            groups={workspace.state === "loaded" ? workspace.groups : undefined}
          >
            {logout.isError ? (
              <p role="alert">
                No fue posible cerrar la sesión. Intenta nuevamente.
              </p>
            ) : null}
            {/* In-memory only; the key drops it on logout or identity swap. */}
            <IssuedCredentialProvider key={`${generation}:${profile.id}`}>
              {!isLoggingOut ? (
                <AppRoutes profile={profile} workspace={workspace} />
              ) : (
                <p role="status">Saliendo...</p>
              )}
            </IssuedCredentialProvider>
          </WorkspaceProvider>
        </PolicyMutationsProvider>
      </ProtectedSessionProvider>
    </AppShell>
  );
}
