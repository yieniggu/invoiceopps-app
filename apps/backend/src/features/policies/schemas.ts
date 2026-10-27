import { z } from "zod";

// Legacy business-policy bodies (no P0 ticket owns them: LEGACY-NO-P0); not in
// OpenAPI.
const manualReviewThreshold = z.number().min(0).max(1);

export const BusinessPolicyCreateSchema = z
  .object({
    version: z.string().trim().min(1).max(120),
    manualReviewThreshold,
  })
  .strict();

export const BusinessPolicyUpdateSchema = z
  .object({ manualReviewThreshold })
  .strict();
