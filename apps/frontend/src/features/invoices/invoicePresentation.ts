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

// Civil dates (YYYY-MM-DD) are shown as DD-MM-YYYY (es-CL) by rearranging the
// string, never through Date, so the day cannot shift with the time zone.
export function invoiceCivilDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "Fecha no disponible";
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

// The business runs on Chilean time: «today» is the Santiago day for everyone,
// not the day of the viewer's device.
const BUSINESS_TIME_ZONE = "America/Santiago";

const businessDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today as a civil date (`YYYY-MM-DD`) in the business time zone. */
export function todayCivilDate(now: Date = new Date()) {
  const part = (type: "year" | "month" | "day") =>
    businessDay.formatToParts(now).find((it) => it.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Past due: pending and the due day already behind today (civil dates compare as text). */
export function isOverdue(
  invoice: { businessStatus: string; dueOn: string },
  today: string = todayCivilDate(),
) {
  return (
    invoice.businessStatus === "PENDING" &&
    /^\d{4}-\d{2}-\d{2}$/.test(invoice.dueOn) &&
    invoice.dueOn < today
  );
}

/** «1 factura» / «57 facturas». */
export function invoiceCountText(total: number) {
  return `${new Intl.NumberFormat("es-CL").format(total)} ${total === 1 ? "factura" : "facturas"}`;
}

/** «Mostrando 21–40 de 57». */
export function invoiceRangeText(
  page: number,
  pageSize: number,
  total: number,
  rows: number,
) {
  const first = (page - 1) * pageSize + 1;
  return `Mostrando ${first}–${first + rows - 1} de ${total}`;
}
