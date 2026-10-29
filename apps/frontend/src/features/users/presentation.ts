/** Account state as text: never conveyed by color alone. */
export const accountStatusLabel = (disabled: boolean) =>
  disabled ? "Desactivado" : "Habilitado";

/** "Recently active" as text. */
export const activityLabel = (recentlyActive: boolean) =>
  recentlyActive ? "Activo" : "Inactivo";
