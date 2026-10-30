import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import { groupInvoicesKey, orgInvoicesKey } from "../../auth/session/queryKeys";
import { listInvoices } from "../api/invoicesApi";
import { useInvoiceAccessLoss } from "../invoiceAccess";
import { invoiceListRequest } from "../invoiceFilters";
import type { InvoiceScope, InvoiceFilters } from "../types";

/**
 * What a list key is a page of: the organization or group, and the ungrouped
 * flag (which shares the organization prefix). Pages and filters of one scope
 * share it; two scopes never do.
 */
function scopeOf(queryKey: QueryKey | undefined) {
  if (queryKey === undefined) return undefined;
  const request = queryKey.at(-1) as { ungrouped?: boolean } | undefined;
  return hashKey([...queryKey.slice(0, -1), request?.ungrouped === true]);
}

/** The last attempt of a query failed and nothing newer succeeded. */
const failedLast = (state: { errorUpdatedAt: number; dataUpdatedAt: number }) =>
  state.errorUpdatedAt > state.dataUpdatedAt;

/**
 * One page of invoices of a scope. The key carries the scope and every
 * filter. Moving between pages or filters of the SAME scope keeps the previous
 * page on screen (flagged `isPlaceholderData`) so the footer and the focus
 * stay put; another scope never inherits it (AC-15), and an answer that
 * arrives late lands in its own entry.
 *
 * A page whose last attempt failed never borrows the previous page: a retry
 * puts a query without data back to «pending», where the placeholder would
 * bring those rows back under the alert. `failed` stays true across that retry
 * (derived from the entry: `errorUpdatedAt` newer than `dataUpdatedAt`), and
 * `error` keeps the failure being retried so the alert text does not change.
 *
 * A 403 means the permission is gone (see `useInvoiceAccessLoss`).
 */
export function useInvoicesQuery(
  scope: InvoiceScope,
  filters: InvoiceFilters,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const identityId = useIdentityId();
  const { organizationId } = scope;
  const groupId = scope.kind === "group" ? scope.groupId : undefined;
  const request = invoiceListRequest(scope, filters);
  const queryKey =
    groupId === undefined
      ? orgInvoicesKey(identityId, organizationId, request)
      : groupInvoicesKey(identityId, organizationId, groupId, request);
  const currentScope = scopeOf(queryKey);
  const client = useQueryClient();

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => listInvoices(scope, request, signal),
    placeholderData: (previous, previousQuery) => {
      const own = client.getQueryState(queryKey);
      if (own && failedLast(own)) return undefined;
      return scopeOf(previousQuery?.queryKey) === currentScope
        ? previous
        : undefined;
    },
    refetchOnWindowFocus: true,
    enabled,
  });

  useInvoiceAccessLoss(
    { kind: "list", organizationId, groupId, queryKey },
    query.error,
    query.errorUpdatedAt,
  );

  // The failure being retried: the entry clears `error` when the retry starts.
  const lastFailure = useRef<{ hash: string; error: unknown } | undefined>(
    undefined,
  );
  const hash = hashKey(queryKey);
  useEffect(() => {
    if (query.error !== null)
      lastFailure.current = { hash, error: query.error };
  }, [hash, query.error]);

  const failed = query.isError || (query.isFetching && failedLast(query));
  const error =
    query.error ??
    (failed && lastFailure.current?.hash === hash
      ? lastFailure.current.error
      : null);
  return {
    query,
    failed,
    error,
    forbidden: isApiError(error) && error.status === 403,
  };
}
