import { z } from "zod";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/**
 * Bounds the offset (at most 10000 x 100 rows) so a deep page cannot force a
 * huge scan; also keeps page x pageSize inside the database integer range.
 */
export const MAX_PAGE = 10_000;

/** Query fields of every paginated list; extend with the list's own filters. */
export const paginationQueryShape = {
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
};

export const PaginationQuerySchema = z
  .object(paginationQueryShape)
  .strict()
  .meta({ id: "PaginationQuery" });

export interface PageQuery {
  page: number;
  pageSize: number;
}

/** Prisma `skip` / `take` of a page. */
export function pageWindow({ page, pageSize }: PageQuery) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/** Response fields every paginated list carries next to its items. */
export const paginationResponseShape = {
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int().nonnegative(),
};

/**
 * Prisma passes `contains` values to LIKE unescaped, so `%` and `_` typed by
 * the caller would act as wildcards. PostgreSQL's default LIKE escape
 * character is the backslash.
 */
export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
