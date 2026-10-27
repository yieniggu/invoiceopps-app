// Pure invoice authorization rules derived from the four independent flags of
// a group. The role of a member (ADMIN included) never grants any of them, and
// no flag implies another one: delete-own and delete-others are evaluated
// against the creator of each invoice, not as an individual exception.

export interface GroupInvoiceFlags {
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}

export type InvoiceCapabilities = GroupInvoiceFlags;

/** The capabilities of every eligible member of the group are its flags. */
export function capabilitiesFromGroup(
  group: GroupInvoiceFlags,
): InvoiceCapabilities {
  return {
    readInvoices: group.readInvoices,
    createInvoices: group.createInvoices,
    deleteOwnInvoices: group.deleteOwnInvoices,
    deleteOthersInvoices: group.deleteOthersInvoices,
  };
}

/** Own invoices need deleteOwn, anyone else's need deleteOthers. */
export function canDeleteInvoice(
  group: GroupInvoiceFlags,
  creatorUserId: string,
  actorUserId: string,
): boolean {
  return creatorUserId === actorUserId
    ? group.deleteOwnInvoices
    : group.deleteOthersInvoices;
}
