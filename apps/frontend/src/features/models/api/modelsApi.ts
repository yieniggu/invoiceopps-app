import { withQuery } from "../../../lib/pagination";
import { apiRequest } from "../../auth/api/apiRequest";
import type {
  DeployInput,
  Deployment,
  DeploymentList,
  ModelCatalog,
  ModelsContext,
} from "../types";

const contextQuery = ({ organizationId, groupId }: ModelsContext) => ({
  organizationId,
  groupId: groupId ?? undefined,
});

export const listModels = (context: ModelsContext, signal?: AbortSignal) =>
  apiRequest<ModelCatalog>(withQuery("/api/v1/models", contextQuery(context)), {
    signal,
  });

export const listDeployments = (context: ModelsContext, signal?: AbortSignal) =>
  apiRequest<DeploymentList>(
    withQuery("/api/v1/deployments", contextQuery(context)),
    { signal },
  );

/** Runs the official gate and loads the version if it passes (takes seconds). */
export const deployModel = (input: DeployInput) =>
  apiRequest<{ deployment: Deployment }>("/api/v1/deployments", {
    method: "POST",
    body: {
      organizationId: input.organizationId,
      groupId: input.groupId,
      registeredModel: input.registeredModel,
      version: input.version,
    },
  }).then(({ deployment }) => deployment);

const deploymentPath = (deploymentId: string, context: ModelsContext) =>
  withQuery(
    `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
    contextQuery(context),
  );

export const setInference = (
  deploymentId: string,
  context: ModelsContext,
  inferenceEnabled: boolean,
) =>
  apiRequest<{ deployment: Deployment }>(
    deploymentPath(deploymentId, context),
    {
      method: "PATCH",
      body: { inferenceEnabled },
    },
  ).then(({ deployment }) => deployment);

export const removeDeployment = (
  deploymentId: string,
  context: ModelsContext,
) =>
  apiRequest<{ deployment: Deployment }>(
    deploymentPath(deploymentId, context),
    {
      method: "DELETE",
    },
  ).then(({ deployment }) => deployment);
