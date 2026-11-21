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

/**
 * Automatic prediction of an invoice by one deployment (MLOPS-06). The API
 * sends them only while the organization's Models section is on.
 */
export interface InvoicePrediction {
  id: string;
  deploymentId: string;
  /** Scope of the model: an organization model or a group model. */
  deploymentScope: "ORGANIZATION" | "GROUP";
  registeredModel: string;
  modelVersion: string;
  runId: string | null;
  /** Probability that the invoice is rejected (0 to 1); `null` until SUCCEEDED. */
  probability: number | null;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An invoice as GET /invoices/{id} answers it: `predictions` only when the API sent them. */
export type InvoiceDetail = Invoice & { predictions?: InvoicePrediction[] };

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

/**
 * Body of POST /invoices. The server owns the creator, the processing status
 * and the id, so none of them is here; `groupId` is absent in the organization
 * scope (never null or empty).
 */
export interface InvoiceCreateInput {
  organizationId: string;
  groupId?: string;
  businessId: string;
  supplierName: string;
  amountPesos: number;
  currency: "CLP";
  issuedOn: string;
  dueOn: string;
  businessStatus: BusinessStatus;
}

/** Invoice as POST /invoices answers it: the stored fields, without `groupName`. */
export type CreatedInvoice = Omit<Invoice, "groupName">;
