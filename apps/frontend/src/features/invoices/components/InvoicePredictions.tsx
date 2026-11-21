import { Loader2, RefreshCw } from "lucide-react";

import { formatInstant } from "../../../lib/datetime";
import type { InvoicePrediction } from "../types";

const percent = new Intl.NumberFormat("es-CL", {
  style: "percent",
  maximumFractionDigits: 0,
});

/**
 * «37%»; a real but tiny probability is never shown as 0, and one that only
 * rounds up to 100 is never shown as certain (CR-589).
 */
export function rejectionPercent(probability: number) {
  if (probability > 0 && probability < 0.005) return "menos de 1%";
  if (probability >= 0.995 && probability < 1) return "más de 99%";
  return percent.format(probability);
}

function Outcome({
  prediction,
  stalled,
}: {
  prediction: InvoicePrediction;
  stalled: boolean;
}) {
  if (prediction.status === "SUCCEEDED" && prediction.probability !== null) {
    const value = rejectionPercent(prediction.probability);
    return (
      <>
        <p className="prediction-value">
          <span className="prediction-label">Probabilidad de rechazo</span>
          <strong>{value}</strong>
        </p>
        <div className="prediction-bar" aria-hidden="true">
          <span
            style={{ width: `${Math.round(prediction.probability * 100)}%` }}
          />
        </div>
      </>
    );
  }
  // One signal per state: a badge (with the spinner inside while it is live).
  if (prediction.status === "PENDING") {
    return (
      <p className="prediction-state">
        <span className="status-badge is-pending button-with-icon">
          {stalled ? null : (
            <Loader2
              className="icon-spin"
              aria-hidden="true"
              focusable="false"
              size={12}
            />
          )}
          Pendiente
        </span>
      </p>
    );
  }
  if (prediction.status === "SKIPPED")
    return (
      <p className="prediction-state">
        <span className="status-badge is-neutral">Omitida</span>
      </p>
    );
  if (prediction.status === "SUCCEEDED")
    return (
      <p className="prediction-state">
        <span className="status-badge is-neutral">Sin resultado</span>
      </p>
    );
  return (
    <p className="prediction-state">
      <span className="status-badge is-rejected">Fallida</span>
    </p>
  );
}

/**
 * Automatic predictions of the invoice (probability of rejection per active
 * model). Hidden when the API sent none (Models section off, no deployment
 * active at creation). A SKIPPED one shows a neutral «Omitida» badge, so a
 * model that did not score the invoice is not mistaken for a missing one. When polling gave up
 * with predictions still PENDING (`stalled`), the animation stops and one
 * refresh button offers another look.
 */
export function InvoicePredictions({
  predictions,
  stalled = false,
  onRefresh,
}: {
  predictions: readonly InvoicePrediction[];
  stalled?: boolean;
  onRefresh?: () => void;
}) {
  if (predictions.length === 0) return null;
  const settling =
    !stalled &&
    predictions.some((prediction) => prediction.status === "PENDING");
  return (
    <section
      className="invoice-predictions"
      aria-labelledby="predictions-title"
      aria-busy={settling || undefined}
    >
      <div className="action-row">
        <h2 id="predictions-title">Predicciones</h2>
        {stalled && onRefresh ? (
          <button
            type="button"
            className="icon-button"
            aria-label="Actualizar predicciones"
            title="Actualizar predicciones"
            onClick={onRefresh}
          >
            <RefreshCw aria-hidden="true" focusable="false" size={16} />
          </button>
        ) : null}
      </div>
      <ul className="prediction-list" aria-live="polite">
        {predictions.map((prediction) => (
          <li key={prediction.id} className="prediction-item">
            <p className="prediction-model">
              {prediction.registeredModel} · versión {prediction.modelVersion}{" "}
              <span className="status-badge">
                {prediction.deploymentScope === "GROUP"
                  ? "Grupo"
                  : "Organización"}
              </span>
            </p>
            <Outcome prediction={prediction} stalled={stalled} />
            {prediction.status === "SUCCEEDED" &&
            prediction.probability !== null ? (
              <p className="muted">{formatInstant(prediction.updatedAt)}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
