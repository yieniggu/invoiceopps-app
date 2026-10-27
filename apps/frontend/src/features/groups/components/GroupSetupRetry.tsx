import { useRetryGroupSetup } from "../hooks/useGroups";
import { isSetupComplete, type GroupSetup } from "../api/groupSetup";
import { MutationFeedback } from "../../../components/MutationFeedback";

/**
 * The group exists but part of its initial setup failed: say exactly which
 * permissions and people are missing, and retry only those.
 */
export function GroupSetupRetry({
  organizationId,
  groupId,
  setup,
  onChange,
}: {
  organizationId: string;
  groupId: string;
  setup: GroupSetup;
  /** Receives what is still missing after a retry (undefined when done). */
  onChange: (remaining: GroupSetup | undefined) => void;
}) {
  const retry = useRetryGroupSetup(organizationId, groupId);
  return (
    <section aria-labelledby={`setup-failed-${groupId}`}>
      <h2 id={`setup-failed-${groupId}`}>Configuración inicial incompleta</h2>
      <p role="alert">El grupo se creó, pero faltó completar lo siguiente:</p>
      <ul>
        {setup.permissions ? <li>Guardar los permisos elegidos.</li> : null}
        {setup.members.map((member) => (
          <li key={member.userId}>Agregar a {member.name} al grupo.</li>
        ))}
      </ul>
      <button
        type="button"
        disabled={retry.isPending}
        onClick={() =>
          retry.mutate(setup, {
            onSuccess: (remaining) =>
              onChange(isSetupComplete(remaining) ? undefined : remaining),
          })
        }
      >
        {retry.isPending ? "Reintentando..." : "Reintentar pasos pendientes"}
      </button>
      <MutationFeedback
        isError={retry.isError}
        error={retry.error}
        isSuccess={false}
        success=""
        fallback="No fue posible reintentar. Intenta nuevamente."
      />
    </section>
  );
}
