export type BusinessStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export const BUSINESS_STATUSES: readonly BusinessStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
];

/** Invoice as GET /invoices answers it. Amounts are whole CLP pesos. */
export interface Invoice {
  id: string;
  organizationId: string;
  /** `null` for an invoice of the organization scope. */
  groupId: string | null;
  /** Name of that group; `null` for the organization scope. */
  groupName: string | null;
  businessId: string;
  supplierName: string;
  amountPesos: number;
  currency: "CLP";
  issuedOn: string;
  dueOn: string;
  businessStatus: BusinessStatus;
  processingStatus: string;
  createdByUserId: string;
  createdAt: string;
}

/** One page of GET /invoices. */
export interface InvoicePage {
  items: Invoice[];
  page: number;
  pageSize: number;
  total: number;
}

/** Where the inbox looks: the whole organization, its ungrouped invoices or one group. */
export type InvoiceScope =
  | { kind: "organization"; organizationId: string }
  | { kind: "ungrouped"; organizationId: string }
  | { kind: "group"; organizationId: string; groupId: string };

/** Filters that live in the URL (page included). */
export interface InvoiceFilters {
  businessStatus?: BusinessStatus;
  issuedFrom?: string;
  issuedTo?: string;
  q: string;
  page: number;
}

/** Exactly what travels in the request and in the query key. */
export interface InvoiceListRequest {
  ungrouped?: true;
  businessStatus?: BusinessStatus;
  issuedFrom?: string;
  issuedTo?: string;
  q?: string;
  page: number;
  pageSize: number;
}
