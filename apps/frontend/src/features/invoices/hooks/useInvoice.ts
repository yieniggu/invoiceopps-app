import { useQuery } from "@tanstack/react-query";

import { isApiError } from "../../auth/api/apiError";
import { useBoundedPolling } from "../../../lib/boundedPolling";
import { useIdentityId } from "../../auth/hooks/useSession";
import { invoiceKey } from "../../auth/session/queryKeys";
import { getInvoice } from "../api/invoicesApi";
import { useInvoiceAccessLoss } from "../invoiceAccess";
import type { InvoiceDetail } from "../types";

/** Predictions the worker has not settled yet. */
export const hasPendingPredictions = (detail: InvoiceDetail | undefined) =>
  detail?.predictions?.some((p) => p.status === "PENDING") === true;

/**
 * One invoice. The key is the document's, whatever route reached it. A 404
 * is rendered from the failed entry, which is dropped when the screen leaves
 * (the invoice is gone or was never visible); a 403
 * clears its data and refreshes the profile, since the permission to read it
 * went away (see `useInvoiceAccessLoss`). PENDING predictions are polled for a bounded
 * time; see `useBoundedPolling`.
 */
export function useInvoiceQuery(
  organizationId: string,
  groupId: string | undefined,
  invoiceId: string,
  enabled: boolean,
) {
  const identityId = useIdentityId();
  const polling = useBoundedPolling<InvoiceDetail>(
    invoiceId,
    hasPendingPredictions,
  );
  const query = useQuery({
    queryKey: invoiceKey(identityId, organizationId, invoiceId),
    queryFn: ({ signal }) =>
      getInvoice(invoiceId, organizationId, groupId, signal),
    enabled,
    refetchInterval: polling.refetchInterval,
  });
  const { gaveUp } = polling.observe(
    query.data,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
  );

  const status = isApiError(query.error) ? query.error.status : undefined;
  useInvoiceAccessLoss(
    { kind: "detail", organizationId, invoiceId },
    query.error,
    query.errorUpdatedAt,
  );

  return {
    query,
    forbidden: status === 403,
    notFound: status === 404,
    /** Polling stopped with predictions still PENDING. */
    gaveUp,
    /** Starts a new bounded run and refreshes now. */
    refresh: () => {
      polling.restart();
      void query.refetch();
    },
  };
}
