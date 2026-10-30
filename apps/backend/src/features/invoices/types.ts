import type { z } from "zod";

import type {
  InvoiceTargetQuerySchema,
  InvoiceListQuerySchema,
  InvoicePageSchema,
  InvoiceCreateRequestSchema,
  InvoiceResponseSchema,
  InvoiceSchema,
  InvoiceViewResponseSchema,
  InvoiceViewSchema,
} from "./schemas.js";

export type InvoiceCreateRequest = z.infer<typeof InvoiceCreateRequestSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;

export type InvoiceView = z.infer<typeof InvoiceViewSchema>;
export type InvoiceViewResponse = z.infer<typeof InvoiceViewResponseSchema>;
export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>;
export type InvoiceListQuery = z.infer<typeof InvoiceListQuerySchema>;
export type InvoiceTargetQuery = z.infer<typeof InvoiceTargetQuerySchema>;
export type InvoicePage = z.infer<typeof InvoicePageSchema>;
