import type { z } from "zod";

import type {
  DeploymentCreateRequestSchema,
  DeploymentListResponseSchema,
  DeploymentSchema,
  DeploymentUpdateRequestSchema,
  ModelListResponseSchema,
  ModelsContextQuerySchema,
} from "./schemas.js";

export type ModelsContextQuery = z.infer<typeof ModelsContextQuerySchema>;
export type DeploymentCreateRequest = z.infer<
  typeof DeploymentCreateRequestSchema
>;
export type DeploymentUpdateRequest = z.infer<
  typeof DeploymentUpdateRequestSchema
>;
export type DeploymentDto = z.infer<typeof DeploymentSchema>;
export type DeploymentListResponse = z.infer<
  typeof DeploymentListResponseSchema
>;
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

/** Where a models operation acts; the workspace derives from it server side. */
export interface ModelsContext {
  organizationId: string;
  groupId: string | null;
}
