export function invoiceLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    PENDING: "Pendiente",
    APPROVED: "Aprobada",
    REJECTED: "Rechazada",
    CANCELLED: "Cancelada",
    NOT_REQUESTED: "Sin procesamiento",
  };
  if (!value) return "Sin datos";
  return Object.hasOwn(labels, value)
    ? labels[value]
    : `Valor no reconocido (${value})`;
}

// Amounts are whole CLP pesos; never divide or add decimals.
export function invoiceMoney(pesos: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(pesos);
}

// Civil dates (YYYY-MM-DD) are shown as given, without time-zone conversion.
export function invoiceCivilDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "Fecha no disponible";
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
