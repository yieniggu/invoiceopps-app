import { useMutation, useQueryClient } from "@tanstack/react-query";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupInvoicesKey,
  orgInvoicesKey,
  profileKey,
} from "../../auth/session/queryKeys";
import { createInvoice } from "../api/invoicesApi";
import type { InvoiceCreateInput } from "../types";

/** Longer than this without an answer is an uncertain attempt, not a hang. */
export const CREATE_TIMEOUT_MS = 30_000;

export interface CreateInvoiceVariables {
  input: InvoiceCreateInput;
  idempotencyKey: string;
}

/**
 * Creates one invoice. The key and body of an attempt are the caller's: a
 * retry passes the same ones. A success marks stale only the lists that can
 * hold the invoice (its group's, and the organization's whole-organization
 * lists; the «sin grupo» ones only for an organization invoice) and writes
 * nothing else: the person may not be able to read the invoice at all, so no
 * follow-up read is made. The client and identity are the ones of the screen
 * that sent the request, so a response that arrives after the session changed
 * lands in the retired partition and nowhere else. A 403 refreshes the
 * profile, since the permission went away.
 */
export function useCreateInvoice() {
  const client = useQueryClient();
  const identityId = useIdentityId();

  return useMutation({
    mutationKey: ["invoices", "create"],
    mutationFn: ({ input, idempotencyKey }: CreateInvoiceVariables) =>
      createInvoice(
        input,
        idempotencyKey,
        AbortSignal.timeout(CREATE_TIMEOUT_MS),
      ),
    onSuccess: (_invoice, { input }) => {
      const { organizationId, groupId } = input;
      void client.invalidateQueries({
        queryKey: orgInvoicesKey(identityId, organizationId),
        predicate: ({ queryKey }) =>
          groupId === undefined || !isUngroupedList(queryKey),
      });
      if (groupId !== undefined)
        void client.invalidateQueries({
          queryKey: groupInvoicesKey(identityId, organizationId, groupId),
        });
    },
    onError: (error) => {
      if (isApiError(error) && error.status === 403)
        void client.invalidateQueries({ queryKey: profileKey(identityId) });
    },
  });
}

/** The «sin grupo asignado» list: its filters carry `ungrouped`. */
function isUngroupedList(queryKey: readonly unknown[]) {
  const filters = queryKey.at(-1) as { ungrouped?: boolean } | undefined;
  return filters?.ungrouped === true;
}
