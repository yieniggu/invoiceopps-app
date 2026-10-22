export function invoiceLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    PENDING: "Pendiente",
    AUTO_PROCESSED: "Procesada automáticamente",
    AUTO_PROCESS: "Procesamiento automático",
    MANUAL_REVIEW: "Revisión manual",
    RULE_V1: "Regla v1",
    PROBABILITY_POLICY: "Política por probabilidad",
    LOCAL_DEMONSTRATION: "Demostración local",
    MODEL_API: "Modelo mediante servidor",
    MODEL_API_FALLBACK: "Respaldo: revisión manual",
    low: "Bajo",
    medium: "Medio",
    high: "Alto",
  };
  if (!value) return "Sin datos";
  return Object.hasOwn(labels, value)
    ? labels[value]
    : `Valor no reconocido (${value})`;
}

export function invoiceMoney(cents: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function invoiceNumber(value: number | null | undefined) {
  return value == null
    ? "Sin datos"
    : new Intl.NumberFormat("es-CL", { maximumFractionDigits: 20 }).format(
        value,
      );
}

export function invoiceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : new Intl.DateTimeFormat("es-CL", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function invoiceHttpMessage(status: number | undefined) {
  if (status === 403)
    return "No tienes permiso para acceder a estas facturas en el contexto seleccionado.";
  if (status === 404)
    return "La factura o el contexto solicitado no está disponible para tu sesión.";
  if (status === 409)
    return "El estado de la factura cambió. Consulta su estado actualizado antes de continuar.";
  if (status === 400)
    return "La consulta o la versión de política no es válida. Usa un máximo de 120 caracteres.";
  return "Intenta nuevamente cuando la conexión esté disponible.";
}
