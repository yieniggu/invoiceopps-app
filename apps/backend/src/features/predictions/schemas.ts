import { z } from "zod";

export const PredictionSchema = z
  .object({
    id: z.uuid(),
    deploymentId: z.uuid(),
    deploymentScope: z.enum(["ORGANIZATION", "GROUP"]).meta({
      description:
        "Scope of the deployment that produced the prediction: an organization model or a group model. A group invoice can carry both.",
    }),
    registeredModel: z.string(),
    modelVersion: z.string(),
    runId: z.string().nullable(),
    probability: z.number().min(0).max(1).nullable().meta({
      description:
        "Probability that the invoice is rejected (0 to 1); null until SUCCEEDED",
    }),
    status: z.enum(["PENDING", "SUCCEEDED", "FAILED", "SKIPPED"]),
    errorCode: z.string().nullable().meta({
      description:
        "Reason code of the last failure or skip (for example MODEL_API_UNREACHABLE); null while healthy",
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: "InvoicePrediction",
    description:
      "Automatic prediction of one invoice by one deployment, computed in the background after the invoice was created.",
  });
