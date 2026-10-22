import type { AuditEvent, InvoiceDetail } from "./InvoiceWorkspace";
import {
  invoiceDate,
  invoiceLabel,
  invoiceNumber,
} from "./invoicePresentation";

export type DecisionInput =
  { mode: "RULE_V1" } | { mode: "PROBABILITY_POLICY"; policyVersion: string };

export function EvaluationScreen({
  invoice,
  event,
  fresh,
  expanded,
  deciding,
  blocked,
  onDecide,
  policyVersion,
  onPolicyVersionChange,
}: {
  invoice: InvoiceDetail;
  event?: AuditEvent;
  fresh: boolean;
  expanded: boolean;
  deciding: boolean;
  blocked: boolean;
  onDecide: (input: DecisionInput) => void;
  policyVersion: string;
  onPolicyVersionChange: (value: string) => void;
}) {
  const validVersion =
    policyVersion.trim().length > 0 && policyVersion.trim().length <= 120;
  return (
    <section aria-labelledby="decision-title">
      <h3 id="decision-title">{expanded ? "Evaluación ML" : "Decisión"}</h3>
      <p>
        Aplicar una regla o una política decide y guarda el estado de la factura
        y su auditoría en el servidor; no es una simulación.
      </p>
      {expanded ? (
        <>
          <p>
            El servidor obtiene la predicción y aplica la política seleccionada.
            El navegador no consulta Model API ni MLflow directamente. La
            probabilidad, el umbral y la versión del modelo son responsabilidad
            del servidor.
          </p>
          <p>
            Probabilidad y umbral se expresan de 0 a 1. Una probabilidad mayor o
            igual al umbral deriva a revisión manual. Si la inferencia falla, el
            servidor registra un respaldo de revisión manual sin inventar una
            probabilidad.
          </p>
          <p>
            Los datos declarados o históricos no son una predicción nueva. Una
            demostración local no acredita inferencia en vivo ni determina la
            fuente de una próxima evaluación.
          </p>
        </>
      ) : null}
      <p>
        Dato declarado de la factura · Probabilidad:{" "}
        {invoiceNumber(invoice.policyProbability)} · Fuente:{" "}
        {invoiceLabel(invoice.policyProbabilitySource)}
      </p>
      {invoice.status === "PENDING" ? (
        <>
          <p>
            Regla v1: el servidor exige un monto menor o igual a 500.000
            centavos (5.000,00 CLP), orden de compra y cotejo de tres vías. No
            utiliza inferencia ML.
          </p>
          <div className="action-row">
            <button
              type="button"
              disabled={deciding || blocked}
              onClick={() => onDecide({ mode: "RULE_V1" })}
            >
              {deciding ? "Registrando decisión..." : "Aplicar Regla v1"}
            </button>
            <label>
              Versión de política
              <input
                maxLength={120}
                value={policyVersion}
                onChange={(event) => onPolicyVersionChange(event.target.value)}
                placeholder="ml-policy-v1"
                aria-describedby="policy-help"
              />
            </label>
            <button
              type="button"
              disabled={deciding || blocked || !validVersion}
              onClick={() => {
                if (validVersion)
                  onDecide({
                    mode: "PROBABILITY_POLICY",
                    policyVersion: policyVersion.trim(),
                  });
              }}
            >
              Aplicar política
            </button>
          </div>
          <p id="policy-help">
            Usa una versión existente de tu contexto (1 a 120 caracteres). Esta
            pantalla no crea ni consulta políticas.
          </p>
        </>
      ) : (
        <p>
          Esta factura ya tiene una decisión registrada. No se ofrece una nueva
          aplicación.
        </p>
      )}
      {deciding ? (
        <p role="status">
          Decisión en curso. Navegar no cancela el procesamiento del servidor.
        </p>
      ) : null}
      {expanded ? (
        event ? (
          <section aria-label="Resultado de evaluación">
            <h4>
              {fresh
                ? "Resultado recibido en esta sesión"
                : "Última evaluación histórica registrada"}
            </h4>
            <dl className="context-details">
              <div>
                <dt>Decisión del servidor</dt>
                <dd>{invoiceLabel(event.decision)}</dd>
              </div>
              <div>
                <dt>Modo aplicado</dt>
                <dd>{invoiceLabel(event.mode)}</dd>
              </div>
              <div>
                <dt>Fuente de probabilidad</dt>
                <dd>{invoiceLabel(event.policyProbabilitySource)}</dd>
              </div>
              <div>
                <dt>Probabilidad (0 a 1)</dt>
                <dd>{invoiceNumber(event.policyProbability)}</dd>
              </div>
              <div>
                <dt>Umbral de revisión manual (0 a 1, inclusivo)</dt>
                <dd>{invoiceNumber(event.manualReviewThreshold)}</dd>
              </div>
              <div>
                <dt>Versión de política</dt>
                <dd>{event.policyVersion ?? "Sin datos"}</dd>
              </div>
              <div>
                <dt>Versión de regla registrada</dt>
                <dd>{event.ruleVersion}</dd>
              </div>
              <div>
                <dt>Recomendación registrada</dt>
                <dd>{invoiceLabel(event.recommendation)}</dd>
              </div>
              <div>
                <dt>Modelo</dt>
                <dd>{event.modelId ?? "Sin datos de modelo"}</dd>
              </div>
              <div>
                <dt>Versión del modelo</dt>
                <dd>{event.modelVersion ?? "Sin datos"}</dd>
              </div>
              <div>
                <dt>Identificador de ejecución</dt>
                <dd>{event.modelRunId ?? "Sin datos"}</dd>
              </div>
              <div>
                <dt>Fecha registrada</dt>
                <dd>{invoiceDate(event.createdAt)}</dd>
              </div>
              <div>
                <dt>Identificador de correlación</dt>
                <dd>{event.correlationId}</dd>
              </div>
            </dl>
            {event.policyProbabilitySource === "MODEL_API_FALLBACK" ? (
              <p>
                Respaldo: revisión manual. No se recibió una predicción
                utilizable; no hay probabilidad ni linaje de modelo disponible.
              </p>
            ) : null}
          </section>
        ) : (
          <p>
            No hay evaluaciones registradas. Los metadatos de modelo, ejecución
            y umbral aún no están disponibles.
          </p>
        )
      ) : null}
    </section>
  );
}
