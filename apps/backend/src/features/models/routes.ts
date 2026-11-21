import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  unauthenticatedResponse,
  unavailableOrRetryableResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { createModelsController } from "./controllers.js";
import {
  DeploymentCreateRequestSchema,
  DeploymentListResponseSchema,
  DeploymentParamsSchema,
  DeploymentResponseSchema,
  DeploymentUpdateRequestSchema,
  ModelListResponseSchema,
  ModelsContextQuerySchema,
} from "./schemas.js";
import type { ModelsService } from "./services.js";

const TAG = "Models";
const NOT_AVAILABLE =
  "the organization does not exist, the actor is not a member (the platform administrator has no implicit membership), the group is not of the organization, or the organization's Models section (mlEnabled) is off; all answer the same body";
const SESSION_ONLY =
  "An API token (Bearer) cannot call this operation: Authorization headers are rejected with 401";
const UNAVAILABLE =
  "SERVICE_UNAVAILABLE: the model service or the MLflow registry is not configured, down or refused the service credential; nothing else in the application is affected";

export function createModelsOperations(
  auth: AuthService | undefined,
  models: ModelsService | undefined,
): Operation[] {
  const controller = createModelsController(auth, models);

  return [
    {
      method: "get",
      path: "/models",
      summary: `List the registered models and versions of a context (session only). ${SESSION_ONLY}`,
      tag: TAG,
      secured: true,
      query: ModelsContextQuerySchema,
      responses: {
        200: {
          description:
            "Models of the workspace derived server side from the context (org-<id> or grp-<id>), read from MLflow with the read-only service identity; includes a link to the MLflow UI",
          schema: ModelListResponseSchema,
        },
        400: validationResponse(
          "missing or malformed organizationId or groupId",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor is not an active member of the context",
        ),
        404: notFoundResponse(NOT_AVAILABLE),
        503: unavailableOrRetryableResponse(UNAVAILABLE),
      },
      handler: controller.listModels,
    },
    {
      method: "get",
      path: "/deployments",
      summary: `List the deployments of a context, history included (session only). ${SESSION_ONLY}`,
      tag: TAG,
      secured: true,
      query: ModelsContextQuerySchema,
      responses: {
        200: {
          description:
            "Latest 100 deployments, newest first. A read only: quarantines, stale checks and orphan models are reconciled with the Model API by a periodic background task, never by this call. `loaded` reports whether the Model API serves each ACTIVE deployment; when it cannot be reached modelApiAvailable is false and loaded is null. `limits.activeCount` counts every ACTIVE or CHECKING deployment of the scope, not only the 100 listed",
          schema: DeploymentListResponseSchema,
        },
        400: validationResponse(
          "missing or malformed organizationId or groupId",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor is not an active member of the context",
        ),
        404: notFoundResponse(NOT_AVAILABLE),
        503: unavailableOrRetryableResponse(UNAVAILABLE),
      },
      handler: controller.listDeployments,
    },
    {
      method: "post",
      path: "/deployments",
      summary: `Deploy a registered model version: the Model API runs the official gate and loads it only if it passes (session only). ${SESSION_ONLY}`,
      tag: TAG,
      secured: true,
      requestBody: DeploymentCreateRequestSchema,
      responses: {
        201: {
          description:
            "The deployment: status ACTIVE (gate passed, scoring still off until enabled) or FAILED with the gate reasons; a gate failure is a normal outcome, not an error",
          schema: DeploymentResponseSchema,
          headers: { "Cache-Control": { description: "no-store" } },
        },
        400: validationResponse(
          "invalid or unknown body field, a version that is not a fixed integer, or a model name with a NUL character",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor is not an active member of the context or lacks deployModels in it (organization flag, or organization OR group flag in a group)",
        ),
        404: notFoundResponse(NOT_AVAILABLE),
        409: errorResponse(
          "DEPLOYMENT_LIMIT: the scope already holds the maximum of active deployments (3 by default) or the model service has no room; CONFLICT: this model version is already being checked, deployed or quarantined in the scope. It is also the answer to a retry of a request whose response was lost (for example a proxy timeout while the gate ran): error.fields carries `deploymentId` and the current `status` (CHECKING, ACTIVE or QUARANTINED), so the client can read that deployment from GET /deployments instead of deploying again",
        ),
        429: errorResponse(
          "RATE_LIMITED: the scope already started the maximum of gate runs this hour (10 by default); Retry-After says when the oldest expires",
        ),
        503: unavailableOrRetryableResponse(UNAVAILABLE),
      },
      handler: controller.deploy,
    },
    {
      method: "patch",
      path: "/deployments/{deploymentId}",
      summary: `Turn the scoring of new invoices with a deployment on or off (session only). ${SESSION_ONLY}`,
      tag: TAG,
      secured: true,
      params: DeploymentParamsSchema,
      query: ModelsContextQuerySchema,
      requestBody: DeploymentUpdateRequestSchema,
      responses: {
        200: {
          description:
            "The deployment; turning scoring on first makes sure the model is loaded in the Model API (re-running the gate after a restart). A repeat that changes nothing answers 200",
          schema: DeploymentResponseSchema,
        },
        400: validationResponse("invalid body or context query"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor is not an active member of the context or lacks deployModels in it",
        ),
        404: notFoundResponse(
          `${NOT_AVAILABLE}; or the deployment does not exist in exactly this context (another organization or group, or a malformed id)`,
        ),
        409: errorResponse(
          "CONFLICT: the deployment is not ACTIVE, was quarantined, or no longer passes the gate; DEPLOYMENT_LIMIT: the model service has no room",
        ),
        503: unavailableOrRetryableResponse(UNAVAILABLE),
      },
      handler: controller.setInference,
    },
    {
      method: "delete",
      path: "/deployments/{deploymentId}",
      summary: `Unload a deployment and mark it INACTIVE, keeping its history (session only). ${SESSION_ONLY}`,
      tag: TAG,
      secured: true,
      params: DeploymentParamsSchema,
      query: ModelsContextQuerySchema,
      responses: {
        200: {
          description:
            "The deployment as INACTIVE with scoring off, freeing its slot; idempotent (an already inactive or failed deployment is returned unchanged). The database is authoritative: an unload that fails is retried when the list reconciles",
          schema: DeploymentResponseSchema,
        },
        400: validationResponse("invalid context query"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor is not an active member of the context or lacks deployModels in it",
        ),
        404: notFoundResponse(
          `${NOT_AVAILABLE}; or the deployment does not exist in exactly this context`,
        ),
        409: errorResponse("CONFLICT: the deployment check is still running"),
        503: retryableConflictResponse,
      },
      handler: controller.remove,
    },
  ];
}
