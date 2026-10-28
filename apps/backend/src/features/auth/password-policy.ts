export const MIN_PASSWORD_LENGTH = 8;
// Upper bound: scrypt cost grows with input, so a password is capped long
// before the JSON body limits (16 kB; 64 kB on the batch operations) could.
export const MAX_PASSWORD_LENGTH = 256;

/** The single length rule: login and password change reject anything longer. */
export function isAcceptablePassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}
