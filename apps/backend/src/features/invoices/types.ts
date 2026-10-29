import type { z } from "zod";

import type {
  InvoiceCreateRequestSchema,
  InvoiceResponseSchema,
  InvoiceSchema,
} from "./schemas.js";

export type InvoiceCreateRequest = z.infer<typeof InvoiceCreateRequestSchema>;
export type Invoice = z.infer<typeof InvoiceSchema>;

export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>;
