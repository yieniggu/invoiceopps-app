import type { Profile } from "../auth/types";
import type { Invoice } from "./types";

/**
 * Whether the profile offers «Eliminar factura» for this invoice. Presentation
 * only: the API decides and answers 403/404 to anything else.
 *
 * The flag depends on the author (`deleteOwnInvoices` when the person created
 * it, else `deleteOthersInvoices`). An invoice of the organization scope looks
 * at the organization flags only; one of a group at the organization flags OR
 * the group's effective flags (when the person is a member of that group).
 * Reading is irrelevant, and ADMIN confers nothing over invoices.
 */
export function canDeleteInvoiceFromProfile(
  { id, memberships }: Pick<Profile, "id" | "memberships">,
  invoice: Pick<Invoice, "organizationId" | "groupId" | "createdByUserId">,
): boolean {
  const membership = memberships.find(
    ({ organization }) => organization.id === invoice.organizationId,
  );
  if (!membership) return false;
  const flag =
    invoice.createdByUserId === id
      ? "deleteOwnInvoices"
      : "deleteOthersInvoices";
  if (membership.permissions[flag]) return true;
  if (invoice.groupId === null) return false;
  return membership.groups.some(
    ({ group, effective }) => group.id === invoice.groupId && effective[flag],
  );
}
