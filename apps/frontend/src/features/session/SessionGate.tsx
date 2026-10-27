import { useLayoutEffect } from "react";
import { Navigate, useLocation } from "react-router";

import { useProfileQuery, useOnboardingReload } from "../auth/hooks/useProfile";
import { useSessionSnapshot, useSessionStore } from "../auth/hooks/useSession";
import { AuthScreen } from "../auth/screens/AuthScreen";
import { ChangePasswordScreen } from "../auth/screens/ChangePasswordScreen";
import { paths } from "../navigation/paths";
import { AuthenticatedApp } from "./AuthenticatedApp";
import { SessionSkeleton } from "./SessionSkeleton";

function useDocumentTitle(title: string | undefined) {
  useLayoutEffect(() => {
    if (title) document.title = `${title} · InvoiceOps`;
  }, [title]);
}

/**
 * Decides what the profile allows: login, the forced password change, the
 * authorized app, or a retry. Access is always derived from the profile
 * query, never from a flag the UI keeps on its own.
 */
export function SessionGate() {
  const store = useSessionStore();
  const { client, phase, endedBy } = useSessionSnapshot();
  const { pathname } = useLocation();
  const profile = useProfileQuery();
  useOnboardingReload();

  const data = profile.data;
  const title =
    phase === "anonymous"
      ? "Iniciar sesión"
      : data?.mustChangePassword
        ? "Cambiar contraseña"
        : data
          ? undefined // The authorized app titles itself per destination.
          : profile.isError && !profile.isFetching
            ? "Sesión no disponible"
            : "Preparando tu espacio de trabajo";
  useDocumentTitle(title);

  if (phase === "anonymous") {
    return <AuthScreen onLogin={() => store.begin(client)} endedBy={endedBy} />;
  }
  if (data) {
    // Onboarding blocks every route except the password change.
    if (data.mustChangePassword) {
      return pathname === paths.changePassword ? (
        <ChangePasswordScreen />
      ) : (
        <Navigate to={paths.changePassword} replace />
      );
    }
    return <AuthenticatedApp profile={data} />;
  }
  if (profile.isError && !profile.isFetching) {
    return (
      <main className="shell" aria-labelledby="page-title">
        <p className="eyebrow">InvoiceOps</p>
        <h1 id="page-title">Mi perfil</h1>
        <p role="alert">No fue posible cargar el perfil.</p>
        <button type="button" onClick={() => void profile.refetch()}>
          Reintentar
        </button>
      </main>
    );
  }
  return <SessionSkeleton />;
}
