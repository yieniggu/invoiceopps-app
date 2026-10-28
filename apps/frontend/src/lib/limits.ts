/** Limits the server enforces, shared by every screen that has to respect them. */

/** The server accepts 1 to 200 people per bulk operation. */
export const MAX_BULK_MEMBERS = 200;

/**
 * Group grants of one created user, summed over every organization (the
 * server rejects more with 400; its 64 kB body is sized for this maximum).
 * Keep in step with MAX_TOTAL_GROUP_GRANTS_PER_USER_CREATION in the backend:
 * a backend test compares them.
 */
export const MAX_TOTAL_GROUP_GRANTS = 200;
