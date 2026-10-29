/**
 * Same shape the server's `z.uuid()` accepts (RFC 4122 versions 1-8, plus the
 * nil and max UUIDs). The server answers 404 NOT_FOUND to a malformed path id
 * (it matches nothing) and 400 VALIDATION_ERROR to a malformed `userIds` query
 * value, so screens treat a malformed path id as "not found" without asking,
 * and `parseUserIds` drops malformed query ids.
 */
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export const isUuid = (value: string): boolean => UUID.test(value);
