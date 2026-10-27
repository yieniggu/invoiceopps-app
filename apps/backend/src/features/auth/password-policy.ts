export const MIN_PASSWORD_LENGTH = 12;
// Upper bound: scrypt cost grows with input and the body limit is only 16 kB.
export const MAX_PASSWORD_LENGTH = 256;

/** The single length rule: login and password change reject anything longer. */
export function isAcceptablePassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}
