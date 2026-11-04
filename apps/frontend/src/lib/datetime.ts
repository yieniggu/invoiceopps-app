const instant = new Intl.DateTimeFormat("es-CL", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * An ISO instant as the screens show it (date and time, in the viewer's own
 * time zone); «Fecha no disponible» when the value is not a readable date.
 */
export function formatInstant(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : instant.format(date);
}
