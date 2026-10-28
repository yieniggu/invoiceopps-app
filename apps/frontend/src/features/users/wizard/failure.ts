import { describeError, isApiError } from "../../auth/api/apiError";
import { TEMPORARY_PASSWORD_LENGTH_MESSAGE } from "./draft";

/** What a rejected creation means for the wizard: where to go and what to say. */
export interface WizardFailure {
  step: 1 | 2 | 3 | 4;
  name?: string;
  rut?: string;
  password?: string;
  general?: string;
}

const FALLBACK =
  "No fue posible crear el usuario. Revisa los datos e intenta nuevamente.";

export function classifyFailure(error: unknown): WizardFailure {
  if (!isApiError(error))
    return { step: 4, general: describeError(error, FALLBACK) };
  if (error.status === 409 && error.code === "USER_CONFLICT")
    return { step: 1, rut: "Ya existe un usuario con ese RUT." };
  if (error.status === 404)
    return {
      step: 2,
      general:
        "Una organización o un grupo elegido ya no existe. Revisa la selección e intenta nuevamente.",
    };
  if (error.status === 400 && error.fields) {
    const keys = Object.keys(error.fields);
    const failure: WizardFailure = { step: 4 };
    if (keys.some((key) => key === "name"))
      failure.name = "Revisa el nombre completo.";
    if (keys.some((key) => key === "rut")) failure.rut = "RUT inválido";
    if (keys.some((key) => key === "temporaryPassword"))
      failure.password = TEMPORARY_PASSWORD_LENGTH_MESSAGE;
    // Group errors live on step 3, the rest of a membership on step 2. The
    // organization-scoped endpoint reports them without the memberships prefix.
    const groupKey = (key: string) =>
      /^(memberships\.\d+\.)?groups(\.|$)/.test(key);
    const membershipKey = (key: string) =>
      !groupKey(key) &&
      (key.startsWith("memberships") ||
        key === "role" ||
        key.startsWith("permissions"));
    if (failure.name || failure.rut || failure.password) failure.step = 1;
    else if (keys.some(membershipKey)) failure.step = 2;
    else if (keys.some(groupKey)) failure.step = 3;
    failure.general = describeError(error, FALLBACK);
    return failure;
  }
  return { step: 4, general: describeError(error, FALLBACK) };
}
