import { PageHeader } from "../../components/PageHeader";

/**
 * Políticas is disabled for now: the route stays reachable but offers nothing.
 * The management screen (PoliciesScreen) is kept in the codebase, unrouted.
 */
export function PoliciesUnavailableScreen() {
  return (
    <div className="screen-stack">
      <PageHeader title="Políticas" />
      <p>No disponible por ahora.</p>
    </div>
  );
}
