import type { AuditEvent } from "./InvoiceWorkspace";
import {
  invoiceDate,
  invoiceLabel,
  invoiceNumber,
} from "./invoicePresentation";

export function InvoiceAuditHistory({ events }: { events: AuditEvent[] }) {
  return (
    <section aria-labelledby="audit-title">
      <h3 id="audit-title">Eventos de auditoría</h3>
      <p>
        Historial registrado por el servidor. Nombre y RUT corresponden a la
        identidad del actor al momento de decidir, no a su perfil actual.
      </p>
      {events.length === 0 ? (
        <p>No hay decisiones registradas.</p>
      ) : (
        <div
          className="workspace-table-scroll"
          role="region"
          aria-label="Auditoría de facturas"
          tabIndex={0}
        >
          <table className="invoice-audit-table text-left text-sm">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Decisión</th>
                <th>Versión de regla</th>
                <th>Modo</th>
                <th>Versión de política</th>
                <th>Probabilidad y umbral</th>
                <th>Origen y modelo</th>
                <th>Actor registrado (nombre y RUT)</th>
                <th>Identificador de correlación</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.correlationId}>
                  <td>
                    <time dateTime={event.createdAt}>
                      {invoiceDate(event.createdAt)}
                    </time>
                  </td>
                  <td>
                    {invoiceLabel(event.decision)}
                    <p>Recomendación: {invoiceLabel(event.recommendation)}</p>
                  </td>
                  <td>{event.ruleVersion}</td>
                  <td>{invoiceLabel(event.mode)}</td>
                  <td>{event.policyVersion ?? "Sin datos"}</td>
                  <td>
                    Probabilidad (0 a 1):{" "}
                    {invoiceNumber(event.policyProbability)}
                    <p>
                      Umbral inclusivo (0 a 1):{" "}
                      {invoiceNumber(event.manualReviewThreshold)}
                    </p>
                  </td>
                  <td>
                    {invoiceLabel(event.policyProbabilitySource)}
                    <p>Modelo: {event.modelId ?? "Sin datos de modelo"}</p>
                    <p>Versión: {event.modelVersion ?? "Sin datos"}</p>
                    <p>Ejecución: {event.modelRunId ?? "Sin datos"}</p>
                  </td>
                  <td>
                    {event.actor.name} ({event.actor.rut})
                  </td>
                  <td>{event.correlationId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
