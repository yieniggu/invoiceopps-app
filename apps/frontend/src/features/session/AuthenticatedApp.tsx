import { useLogoutMutation } from "../auth/hooks/useAuthMutations";
import { ProtectedSessionProvider } from "../auth/components/ProtectedSession";
import { useSessionSnapshot, useSessionStore } from "../auth/hooks/useSession";
import type { Profile } from "../auth/types";
import { hasInvoiceAccess } from "../invoices/invoiceScopes";
import { hasModelsAccess } from "../models/modelsContexts";
import { AppShell } from "../navigation/AppShell";
import { IssuedCredentialProvider } from "../users/components/IssuedCredentialProvider";
import { WorkspaceProvider } from "../workspace/WorkspaceContext";
import { useWorkspaceGroups } from "../workspace/useWorkspaceGroups";
import { AppRoutes } from "./AppRoutes";

/** Everything a person with a settled password can reach. */
export function AuthenticatedApp({ profile }: { profile: Profile }) {
  const store = useSessionStore();
  const { client, generation } = useSessionSnapshot();
  const logout = useLogoutMutation();
  const workspace = useWorkspaceGroups(profile);

  // The only signal of a logout in flight is the spinner of the «Salir»
  // button; the content stays as it is until the session ends.
  const isLoggingOut = logout.isPending;
  return (
    <AppShell
      onLogout={() => logout.mutate()}
      isLoggingOut={isLoggingOut}
      isPlatformAdministrator={profile.isPlatformAdministrator}
      showInvoices={hasInvoiceAccess(profile)}
      showApiTokens={profile.memberships.length > 0}
      showModels={hasModelsAccess(profile)}
    >
      {/* A stale 401 from a retired partition is ignored because `end`
          compares clients. Políticas is disabled, so its mutation ledger is
          not mounted here. */}
      <ProtectedSessionProvider onUnauthorized={() => store.end(client)}>
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
            <AppRoutes profile={profile} workspace={workspace} />
          </IssuedCredentialProvider>
        </WorkspaceProvider>
      </ProtectedSessionProvider>
    </AppShell>
  );
}
