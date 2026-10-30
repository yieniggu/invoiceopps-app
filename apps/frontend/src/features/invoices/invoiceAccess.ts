import {
  hashKey,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";

import { isApiError } from "../auth/api/apiError";
import { useIdentityId } from "../auth/hooks/useSession";
import {
  groupInvoicesKey,
  invoiceKey,
  orgInvoiceDetailsKey,
  orgInvoicesKey,
  profileKey,
} from "../auth/session/queryKeys";

// One place decides what the invoice screens do when the API says the access
// is gone (403) or the invoice is not there (404). The query hooks and the
// delete mutation share it, so no screen repeats the cache bookkeeping.

/** The permission went away: the profile is asked again (once per error). */
const refreshProfile = (client: QueryClient, identityId: string) =>
  void client.invalidateQueries({ queryKey: profileKey(identityId) });

/** An invoice that is gone or never visible: nothing of it stays cached. */
export async function forgetInvoice(
  client: QueryClient,
  identityId: string,
  organizationId: string,
  invoiceId: string,
) {
  const queryKey = invoiceKey(identityId, organizationId, invoiceId);
  await client.cancelQueries({ queryKey, exact: true });
  client.removeQueries({ queryKey, exact: true });
}

/**
 * The permission to read a scope's lists is gone. Restricted data does not
 * linger: the other cached lists of the scope and every cached detail of the
 * organization are removed. The failed (active) entry stays, so the screen is
 * not re-armed to ask again before the profile answers.
 */
function revokeListAccess(
  client: QueryClient,
  identityId: string,
  organizationId: string,
  groupId: string | undefined,
  activeHash: string,
) {
  client.removeQueries({
    queryKey:
      groupId === undefined
        ? orgInvoicesKey(identityId, organizationId)
        : groupInvoicesKey(identityId, organizationId, groupId),
    predicate: (other) => other.queryHash !== activeHash,
  });
  client.removeQueries({
    queryKey: orgInvoiceDetailsKey(identityId, organizationId),
  });
  refreshProfile(client, identityId);
}

/**
 * The permission to read one invoice is gone. Its data is cleared but the
 * failed entry stays (a reset would refetch the active query and answer 403
 * again, forever).
 */
function revokeDetailAccess(
  client: QueryClient,
  identityId: string,
  organizationId: string,
  invoiceId: string,
) {
  client
    .getQueryCache()
    .find({
      queryKey: invoiceKey(identityId, organizationId, invoiceId),
      exact: true,
    })
    ?.setState({ data: undefined });
  refreshProfile(client, identityId);
}

/**
 * The invoice answered 404 to a delete: it is gone. A detail screen that is
 * mounted renders the not-found state from the entry, so the entry is marked
 * failed instead of removed (removing an active query makes the next render
 * ask again: CR-381); `useInvoiceAccessLoss` drops it when the screen leaves.
 * An entry nobody watches is simply removed.
 */
async function markInvoiceGone(
  client: QueryClient,
  identityId: string,
  organizationId: string,
  invoiceId: string,
  error: Error,
) {
  const queryKey = invoiceKey(identityId, organizationId, invoiceId);
  await client.cancelQueries({ queryKey, exact: true });
  const entry = client.getQueryCache().find({ queryKey, exact: true });
  if (!entry) return;
  if (entry.getObserversCount() === 0) {
    client.removeQueries({ queryKey, exact: true });
    return;
  }
  entry.setState({
    data: undefined,
    error,
    status: "error",
    fetchStatus: "idle",
    errorUpdatedAt: Date.now(),
  });
}

/** A failed delete: 404 marks the detail gone, 403 refreshes the profile. */
export async function handleDeleteFailure(
  client: QueryClient,
  identityId: string,
  organizationId: string,
  invoiceId: string,
  error: unknown,
) {
  if (!isApiError(error)) return;
  if (error.status === 404)
    await markInvoiceGone(client, identityId, organizationId, invoiceId, error);
  else if (error.status === 403) refreshProfile(client, identityId);
}

type AccessTarget =
  | {
      kind: "detail";
      organizationId: string;
      invoiceId: string;
    }
  | {
      kind: "list";
      organizationId: string;
      groupId: string | undefined;
      queryKey: readonly unknown[];
    };

/**
 * Reacts once per failed read of an invoice list or detail: on a 403 the
 * restricted entries go and the profile is refreshed; a detail that answered
 * 404 is dropped when the screen leaves it. Keyed by `errorUpdatedAt`, so a repeated render never repeats it.
 */
export function useInvoiceAccessLoss(
  target: AccessTarget,
  error: unknown,
  errorUpdatedAt: number,
) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const status = isApiError(error) ? error.status : undefined;
  const { kind, organizationId } = target;
  const invoiceId = target.kind === "detail" ? target.invoiceId : undefined;
  const groupId = target.kind === "list" ? target.groupId : undefined;
  const activeHash =
    target.kind === "list" ? hashKey(target.queryKey) : undefined;

  useEffect(() => {
    if (status === 403 && kind === "list" && activeHash !== undefined)
      revokeListAccess(client, identityId, organizationId, groupId, activeHash);
    else if (status === 403 && invoiceId !== undefined)
      revokeDetailAccess(client, identityId, organizationId, invoiceId);
  }, [
    client,
    identityId,
    kind,
    organizationId,
    groupId,
    invoiceId,
    activeHash,
    status,
    errorUpdatedAt,
  ]);

  // A 404 is rendered from the failed entry, which therefore stays while the
  // screen is up (removing the active query would let the next render create
  // it again and ask again). It is dropped when the screen leaves the invoice.
  useEffect(() => {
    if (invoiceId === undefined) return;
    const queryKey = invoiceKey(identityId, organizationId, invoiceId);
    return () => {
      const entry = client.getQueryCache().find({ queryKey, exact: true });
      if (isApiError(entry?.state.error) && entry.state.error.status === 404)
        client.removeQueries({ queryKey, exact: true });
    };
  }, [client, identityId, organizationId, invoiceId]);
}
