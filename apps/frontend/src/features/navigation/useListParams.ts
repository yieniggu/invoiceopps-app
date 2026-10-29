import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { MAX_PAGE } from "../../lib/pagination";

/**
 * `?page=` as a page number: an integer from 1 to the server's maximum. Any
 * other value (missing, text, decimal, zero, negative, above the server's
 * limit, which would answer 400) means the first page.
 */
export function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1;
}

/** Relative link of a page of the current list (page 1 is the clean URL). */
export const pageSearch = (page: number) => (page > 1 ? `?page=${page}` : "?");

/** `?page=` of the URL, validated; Back restores the page. */
export function usePageParam() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return {
    page: parsePage(params.get("page")),
    setPage: (next: number) => navigate(pageSearch(next)),
  };
}

/**
 * A page past the end of the list (a bookmark, a list that shrank): the rows
 * are empty but the total is not, so "no results" would be false. Once the
 * answer for this very page has arrived, the URL moves (`replace`, so Back
 * does not return to the empty page) to the last page that exists.
 *
 * Returns whether the current page is out of range, so the screen can hold
 * its empty-state copy back for the instant before the redirect.
 *
 * `settled` is false while the data on screen belongs to another page (kept
 * as a placeholder) or has not arrived.
 */
export function useOutOfRangeRedirect(
  {
    page,
    pageSize,
    total,
    rowCount,
    settled,
  }: {
    page: number;
    pageSize: number;
    total: number | undefined;
    rowCount: number;
    settled: boolean;
  },
  /** Where the last page lives: a relative or absolute URL. */
  toPage: (page: number) => string,
): boolean {
  const navigate = useNavigate();
  const pages = Math.max(1, Math.ceil((total ?? 0) / pageSize));
  const outOfRange =
    settled && (total ?? 0) > 0 && rowCount === 0 && page > pages;
  const target = outOfRange ? toPage(pages) : undefined;
  useEffect(() => {
    if (target !== undefined) navigate(target, { replace: true });
  }, [target, navigate]);
  return outOfRange;
}
