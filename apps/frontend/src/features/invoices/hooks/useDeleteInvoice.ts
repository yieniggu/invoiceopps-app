import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useIdentityId } from "../../auth/hooks/useSession";
import {
  groupInvoicesKey,
  invoiceKey,
  orgInvoicesKey,
} from "../../auth/session/queryKeys";
import { deleteInvoice } from "../api/invoicesApi";
import { forgetInvoice, handleDeleteFailure } from "../invoiceAccess";

/**
 * Deletes one invoice. On 204 the detail is cancelled first (an in-flight read
 * must not repopulate it) and removed, and only the lists that can hold the
 * invoice are RESET: its group's (if any) and the organization-wide and
 * ungrouped ones of its organization. A reset, unlike an invalidation, leaves
 * no data behind, so the inbox the person returns to can never paint the
 * deleted row from the cache while it loads. A 404 drops the detail; a 403
 * refreshes the profile since the permission went away. Neither simulates
 * success.
 */
export function useDeleteInvoice(
  organizationId: string,
  groupId: string | undefined,
  invoiceId: string,
) {
  const client = useQueryClient();
  const identityId = useIdentityId();

  const mutation = useMutation({
    mutationKey: ["invoices", "delete", invoiceId],
    mutationFn: () => deleteInvoice(invoiceId, organizationId, groupId),
    onSuccess: async () => {
      await forgetInvoice(client, identityId, organizationId, invoiceId);
      const lists: Array<readonly unknown[]> = [
        orgInvoicesKey(identityId, organizationId),
      ];
      if (groupId !== undefined)
        lists.push(groupInvoicesKey(identityId, organizationId, groupId));
      await Promise.all(
        lists.map((queryKey) => client.resetQueries({ queryKey })),
      );
    },
    onError: (error) =>
      handleDeleteFailure(client, identityId, organizationId, invoiceId, error),
  });

  // Re-rendering the screen with the entry gone re-creates an empty one;
  // leaving the screen after a success drops that leftover too.
  const succeeded = mutation.isSuccess;
  useEffect(() => {
    if (!succeeded) return;
    const key = invoiceKey(identityId, organizationId, invoiceId);
    return () => client.removeQueries({ queryKey: key, exact: true });
  }, [succeeded, client, identityId, organizationId, invoiceId]);

  return mutation;
}
