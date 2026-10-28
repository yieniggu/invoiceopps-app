import { act } from "@testing-library/react";
import type { ComponentType } from "react";
import { Route, Routes } from "react-router";

import { PageHeader } from "../components/PageHeader";
import { PoliciesScreen } from "../features/policies/PoliciesScreen";
import { PolicyMutationsProvider } from "../features/policies/PolicyMutationsContext";
import type { AppRoutes } from "../features/session/AppRoutes";
import { WorkspaceBoundary } from "../features/workspace/WorkspaceContext";

type Props = Parameters<typeof AppRoutes>[0];

/**
 * Políticas is disabled in the product: `/policies` shows "No disponible por
 * ahora." and the sidebar item is not a link. The policy screen is kept
 * unrouted, and these suites keep exercising it (session-owned policy writes,
 * owner selection, late responses) through this test-only route, which puts
 * the original workspace-gated screen back at `/policies`. The product no
 * longer mounts the policy mutation ledger, so this wrapper mounts the
 * provider itself (keyed by identity, like the product did).
 */
export function withPoliciesRoute(Original: ComponentType<Props>) {
  return function AppRoutesWithPolicies(props: Props) {
    const { state, groups, retry } = props.workspace;
    return (
      <PolicyMutationsProvider key={props.profile.id}>
        <Routes>
          <Route
            path="policies"
            element={
              <div className="screen-stack">
                <PageHeader
                  title="Políticas"
                  description="Consulta y versiona los umbrales de revisión de tu organización o grupo."
                />
                {state === "loaded" && groups ? (
                  <WorkspaceBoundary>
                    <PoliciesScreen profile={props.profile} />
                  </WorkspaceBoundary>
                ) : state === "error" ? (
                  <>
                    <p role="alert">
                      No fue posible cargar el contexto de trabajo.
                    </p>
                    <button type="button" onClick={retry}>
                      Reintentar contexto
                    </button>
                  </>
                ) : (
                  <p role="status">Cargando contexto de trabajo...</p>
                )}
              </div>
            }
          />
          <Route path="*" element={<Original {...props} />} />
        </Routes>
      </PolicyMutationsProvider>
    );
  };
}

/** Opens `/policies` the way the browser does (history entry + popstate). */
export async function openPolicies() {
  await act(async () => {
    window.history.pushState(null, "", "/policies");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}
