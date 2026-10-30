import { parsePage } from "../navigation/useListParams";
import { scopeToSearch } from "./invoiceScopes";
import {
  BUSINESS_STATUSES,
  type BusinessStatus,
  type InvoiceScope,
  type InvoiceFilters,
  type InvoiceListRequest,
} from "./types";

/** Longest text the API accepts in `q`. */
export const MAX_QUERY_LENGTH = 120;
export const INVOICE_PAGE_SIZE = 20;

/** Earliest year a date filter is applied; typing a year passes through 0002… */
export const MIN_FILTER_YEAR = 1900;

/** Lowest date the date inputs offer (`min`), as the API-facing text. */
export const MIN_FILTER_DATE = `${MIN_FILTER_YEAR}-01-01`;

/** `YYYY-MM-DD` that is a real calendar day, whatever its year. */
function isCivilDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/**
 * A complete date worth querying: a real `YYYY-MM-DD` day with a four-digit
 * year of 1900 or later. A date input reports partial years while one types,
 * and the URL is held to the same rule, so a link naming year 0002 is ignored
 * exactly like the same date typed in the box.
 */
export const isApplicableDate = (value: string) =>
  isCivilDate(value) && Number(value.slice(0, 4)) >= MIN_FILTER_YEAR;

/** A real day that only fails the minimum year (worth telling the person). */
export const isBelowMinimumDate = (value: string) =>
  isCivilDate(value) && Number(value.slice(0, 4)) < MIN_FILTER_YEAR;

const applicableDate = (value: string | null): string | undefined =>
  value !== null && isApplicableDate(value) ? value : undefined;

const businessStatus = (value: string | null): BusinessStatus | undefined =>
  BUSINESS_STATUSES.find((status) => status === value);

/** Filters of the URL; whatever the API would refuse is dropped. */
export function invoiceFiltersFromSearch(
  search: URLSearchParams,
): InvoiceFilters {
  const text = (search.get("q") ?? "").trim();
  const status = businessStatus(search.get("businessStatus"));
  const issuedFrom = applicableDate(search.get("issuedFrom"));
  const issuedTo = applicableDate(search.get("issuedTo"));
  return {
    ...(status ? { businessStatus: status } : {}),
    ...(issuedFrom ? { issuedFrom } : {}),
    ...(issuedTo ? { issuedTo } : {}),
    q: text.length <= MAX_QUERY_LENGTH ? text : "",
    page: parsePage(search.get("page")),
  };
}

/** The API refuses a range whose end precedes its start. */
export const hasInvertedRange = ({ issuedFrom, issuedTo }: InvoiceFilters) =>
  issuedFrom !== undefined && issuedTo !== undefined && issuedFrom > issuedTo;

/** Query string of the inbox URL: scope first, then the non-default filters. */
export function invoiceSearch(
  scope: InvoiceScope,
  filters: InvoiceFilters,
): string {
  const params = new URLSearchParams(scopeToSearch(scope));
  if (filters.businessStatus)
    params.set("businessStatus", filters.businessStatus);
  if (filters.issuedFrom) params.set("issuedFrom", filters.issuedFrom);
  if (filters.issuedTo) params.set("issuedTo", filters.issuedTo);
  if (filters.q) params.set("q", filters.q);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

/** The part of the filters that goes to the API and into the query key. */
export function invoiceListRequest(
  scope: InvoiceScope,
  filters: InvoiceFilters,
): InvoiceListRequest {
  return {
    ...(scope.kind === "ungrouped" ? { ungrouped: true as const } : {}),
    ...(filters.businessStatus
      ? { businessStatus: filters.businessStatus }
      : {}),
    ...(filters.issuedFrom ? { issuedFrom: filters.issuedFrom } : {}),
    ...(filters.issuedTo ? { issuedTo: filters.issuedTo } : {}),
    ...(filters.q ? { q: filters.q } : {}),
    page: filters.page,
    pageSize: INVOICE_PAGE_SIZE,
  };
}

/** Whether any filter besides the scope is set (page does not count). */
export const hasActiveFilters = ({
  businessStatus,
  issuedFrom,
  issuedTo,
  q,
}: InvoiceFilters) =>
  businessStatus !== undefined ||
  issuedFrom !== undefined ||
  issuedTo !== undefined ||
  q !== "";
