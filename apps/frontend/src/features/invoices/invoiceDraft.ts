import { amountFailureMessage, parseAmountPesos } from "./invoiceAmount";
import { isApplicableDate } from "./invoiceFilters";
import type { BusinessStatus, InvoiceCreateInput } from "./types";

// Validation of the create form, field by field, with the limits of the API
// schema (apps/backend/src/features/invoices/schemas.ts).

export const MAX_BUSINESS_ID = 80;
export const MAX_SUPPLIER_NAME = 200;

/** What the person typed; the scope is chosen apart. */
export interface InvoiceDraft {
  businessId: string;
  supplierName: string;
  amount: string;
  issuedOn: string;
  dueOn: string;
  businessStatus: BusinessStatus;
}

/** Fields in screen order, which is also the order of the focus. */
export const DRAFT_FIELDS = [
  "businessId",
  "supplierName",
  "amount",
  "issuedOn",
  "dueOn",
] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];
export type DraftErrors = Partial<Record<DraftField, string>>;

// PostgreSQL text can not hold a NUL.
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/;

function textError(
  value: string,
  { empty, max, tooLong }: { empty: string; max: number; tooLong: string },
) {
  const text = value.trim();
  if (text === "") return empty;
  if (text.length > max) return tooLong;
  if (NUL.test(text)) return "Hay caracteres que no se pueden guardar.";
  return undefined;
}

export function validateDraft(draft: InvoiceDraft): DraftErrors {
  const errors: DraftErrors = {};
  const businessId = textError(draft.businessId, {
    empty: "Ingresa el número de la factura.",
    max: MAX_BUSINESS_ID,
    tooLong: `El número de la factura admite hasta ${MAX_BUSINESS_ID} caracteres.`,
  });
  if (businessId) errors.businessId = businessId;
  const supplierName = textError(draft.supplierName, {
    empty: "Ingresa el nombre del proveedor.",
    max: MAX_SUPPLIER_NAME,
    tooLong: `El nombre del proveedor admite hasta ${MAX_SUPPLIER_NAME} caracteres.`,
  });
  if (supplierName) errors.supplierName = supplierName;
  const amount = parseAmountPesos(draft.amount);
  if (!amount.ok) errors.amount = amountFailureMessage(amount.failure);
  if (draft.issuedOn === "") errors.issuedOn = "Ingresa la fecha de emisión.";
  else if (!isApplicableDate(draft.issuedOn))
    errors.issuedOn = "Ingresa una fecha de emisión válida.";
  if (draft.dueOn === "") errors.dueOn = "Ingresa la fecha de vencimiento.";
  else if (!isApplicableDate(draft.dueOn))
    errors.dueOn = "Ingresa una fecha de vencimiento válida.";
  else if (!errors.issuedOn && draft.dueOn < draft.issuedOn)
    errors.dueOn =
      "La fecha de vencimiento no puede ser anterior a la fecha de emisión.";
  return errors;
}

/**
 * The request body of a draft that passed `validateDraft`. The organization
 * scope carries no `groupId` at all.
 */
export function draftToInput(
  draft: InvoiceDraft,
  scope: { organizationId: string; groupId: string | null },
): InvoiceCreateInput {
  const amount = parseAmountPesos(draft.amount);
  if (!amount.ok) throw new Error("The draft was not validated");
  return {
    organizationId: scope.organizationId,
    ...(scope.groupId === null ? {} : { groupId: scope.groupId }),
    businessId: draft.businessId.trim(),
    supplierName: draft.supplierName.trim(),
    amountPesos: amount.pesos,
    currency: "CLP",
    issuedOn: draft.issuedOn,
    dueOn: draft.dueOn,
    businessStatus: draft.businessStatus,
  };
}
