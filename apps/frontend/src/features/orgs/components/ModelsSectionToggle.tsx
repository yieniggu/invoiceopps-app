import { ConfirmAction } from "../../../components/ConfirmAction";
import { LiveStatus } from "../../../components/LiveStatus";
import { MutationFeedback } from "../../../components/MutationFeedback";
import { SwitchButton } from "../../../components/SwitchButton";
import { useUpdateOrganization } from "../hooks/useOrganizations";

const LABEL = "Sección Modelos";

/**
 * Turns the Models section (MLOPS-05) of an organization on or off. Off by
 * default; only an ADMIN (or the platform administrator) sees it. It is a
 * switch: the state is `aria-checked`, the visible text is its name. Turning
 * it on is immediate; turning it off asks first (it hides the section, and
 * the MLflow token stops working for the whole organization). Both directions
 * are the same `SwitchButton`, so focus stays on it after the change.
 */
export function ModelsSectionToggle({
  organizationId,
  enabled,
}: {
  organizationId: string;
  enabled: boolean;
}) {
  const update = useUpdateOrganization(organizationId);
  const set = (mlEnabled: boolean) => {
    update.reset();
    update.mutate({ mlEnabled });
  };
  return (
    <div className="screen-stack">
      <div className="action-row">
        {/* One switch for both directions, so the node (and its focus)
            survives the change; only turning it off asks first. */}
        <ConfirmAction
          label={LABEL}
          confirmLabel="Confirmar: desactivar"
          pending={update.isPending}
          onConfirm={() => set(false)}
          renderTrigger={({ open, ref, locked }) => (
            <SwitchButton
              ref={ref}
              label={LABEL}
              checked={enabled}
              pending={update.isPending}
              locked={locked}
              onToggle={enabled ? open : () => set(true)}
            />
          )}
        />
      </div>
      <LiveStatus
        pending={update.isPending}
        succeeded={update.isSuccess}
        pendingText={`${LABEL}: guardando`}
        doneText={`${LABEL}: ${update.variables?.mlEnabled ? "activada" : "desactivada"}`}
      />
      <MutationFeedback
        isError={update.isError}
        error={update.error}
        isSuccess={false}
        success=""
        fallback="No fue posible cambiar la sección Modelos."
      />
    </div>
  );
}
