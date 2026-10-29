/**
 * PostgreSQL text cannot store U+0000: a value carrying one fails inside the
 * database and would surface as a 500. Free-text request fields reject it up
 * front, as a validation error (use with `.refine(hasNoNul, NO_NUL)`).
 */
export const hasNoNul = (value: string) => !value.includes("\u0000");

export const NO_NUL = { message: "Must not contain a NUL character" } as const;
