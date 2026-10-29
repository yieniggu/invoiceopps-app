import type { Prisma } from "./generated/prisma/client.js";
import { escapeLike } from "./pagination.js";

/** Canonical RUT spelling of a search term: no dots, hyphens or spaces. */
function normalizeRutSearch(search: string) {
  return search.replace(/[.\-\s]/g, "").toUpperCase();
}

/**
 * Case-insensitive fragment of the name, or fragment of the RUT typed with or
 * without dots and hyphen. LIKE wildcards in the term are literal. Shared by
 * the platform directory and the organization users list so both search alike.
 */
export function userSearchCondition(search: string): Prisma.UserWhereInput {
  const rut = normalizeRutSearch(search);
  return {
    OR: [
      { name: { contains: escapeLike(search), mode: "insensitive" } },
      // A search made only of punctuation has no RUT part: matching the
      // empty string would select every user.
      ...(rut === "" ? [] : [{ rut: { contains: escapeLike(rut) } }]),
    ],
  };
}
