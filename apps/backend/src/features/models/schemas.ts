import { z } from "zod";

import { hasNoNul, NO_NUL } from "../../text.js";

const ContextQueryShape = {
  organizationId: z.uuid(),
  groupId: z.uuid().optional().meta({
    description:
      "Group context; omitted means the organization context (workspace org-<organizationId>, otherwise grp-<groupId>)",
  }),
};

/** Context of every models operation; the server derives the workspace from it. */
export const ModelsContextQuerySchema = z
  .object(ContextQueryShape)
  .strict()
  .meta({ id: "ModelsContextQuery" });

export const DeploymentParamsSchema = z.object({ deploymentId: z.uuid() });

const registeredModel = z
  .string()
  .min(1)
  .max(256)
  .refine(hasNoNul, NO_NUL)
  .meta({ description: "Registered model name in the context's workspace" });

const version = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/, "Expected a fixed integer version")
  .meta({
    description: "Fixed integer model version (an alias is never accepted)",
  });

export const DeploymentCreateRequestSchema = z
  .object({
    organizationId: z.uuid(),
    groupId: z.uuid().nullable().default(null),
    registeredModel,
    version,
  })
  .strict()
  .meta({
    id: "DeploymentCreateRequest",
    description:
      "Deploys one registered model version into the context: the Model API runs the official gate and loads the version only if it passes.",
  });

export const DeploymentUpdateRequestSchema = z
  .object({ inferenceEnabled: z.boolean() })
  .strict()
  .meta({
    id: "DeploymentUpdateRequest",
    description:
      "Turns the scoring of new invoices with this deployment on or off.",
  });

export const RegisteredModelVersionSchema = z
  .object({
    version: z.string(),
    runId: z.string().nullable(),
    createdAt: z.string().nullable(),
    gateStatus: z
      .string()
      .nullable()
      .meta({ description: "Value of the version's gate_status tag, if any" }),
  })
  .meta({ id: "RegisteredModelVersion" });

export const RegisteredModelSchema = z
  .object({ name: z.string(), versions: z.array(RegisteredModelVersionSchema) })
  .meta({ id: "RegisteredModel" });

export const ModelListResponseSchema = z
  .object({
    workspace: z.string(),
    mlflowUrl: z.string().nullable().meta({
      description:
        "Link to the MLflow UI already positioned on this context (?context=<workspace>); null while MLFLOW_PUBLIC_URL is not configured",
    }),
    models: z.array(RegisteredModelSchema),
    truncated: z.boolean(),
  })
  .meta({ id: "ModelListResponse" });

export const GateReasonSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "GateReason" });

export const GateMetricsSchema = z
  .object({
    auc: z.number().nullable(),
    dummyAuc: z.number().nullable(),
    lift: z.number().nullable(),
    minAuc: z.number().nullable(),
    minLift: z.number().nullable(),
    validationRows: z.number().nullable(),
  })
  .meta({ id: "GateMetrics" });

export const GateReportSchema = z
  .object({
    passed: z.boolean(),
    metrics: GateMetricsSchema.nullable(),
    reasons: z.array(GateReasonSchema),
    featureSchemaVersion: z.string().nullable(),
    checkedAt: z.string(),
  })
  .meta({
    id: "GateReport",
    description:
      "Result of the last gate run. Reason codes are stable identifiers the UI translates; messages are English diagnostics.",
  });

export const DeploymentStatusSchema = z.enum([
  "CHECKING",
  "ACTIVE",
  "INACTIVE",
  "FAILED",
  "QUARANTINED",
]);

export const DeploymentSchema = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    groupId: z.uuid().nullable(),
    workspace: z.string(),
    registeredModel: z.string(),
    version: z.string(),
    runId: z.string().nullable(),
    status: DeploymentStatusSchema,
    inferenceEnabled: z.boolean(),
    loaded: z.boolean().nullable().meta({
      description:
        "ACTIVE only: whether the Model API currently serves it (false after a Model API restart until it is toggled on again); null when unknown or not ACTIVE",
    }),
    gate: GateReportSchema.nullable(),
    createdByUserId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "Deployment" });

export const DeploymentResponseSchema = z
  .object({ deployment: DeploymentSchema })
  .meta({ id: "DeploymentResponse" });

export const DeploymentListResponseSchema = z
  .object({
    items: z.array(DeploymentSchema),
    limits: z.object({
      activeCount: z.number().int().nonnegative(),
      maxActive: z.number().int().positive(),
      maxChecksPerHour: z.number().int().positive(),
    }),
    modelApiAvailable: z.boolean().meta({
      description:
        "False when the Model API could not be reached to reconcile the list; statuses are then the last known ones",
    }),
  })
  .meta({
    id: "DeploymentListResponse",
    description:
      "The latest 100 deployments of the context, newest first, history included.",
  });
