import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  DeploymentCreateRequestSchema,
  DeploymentParamsSchema,
  DeploymentUpdateRequestSchema,
  ModelsContextQuerySchema,
} from "./schemas.js";
import type { ModelsService } from "./services.js";
import type { ModelsContext } from "./types.js";

/** A route whose backing service is not wired answers like a missing session. */
function wired(service: ModelsService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

function contextOf(query: unknown): ModelsContext {
  const parsed = parseWith(
    ModelsContextQuerySchema,
    query,
    "Invalid models context",
  );
  return {
    organizationId: parsed.organizationId,
    groupId: parsed.groupId ?? null,
  };
}

/** A malformed id answers the same generic 404 as a missing deployment. */
function parseDeploymentId(params: unknown) {
  const parsed = DeploymentParamsSchema.safeParse(params);
  if (!parsed.success) throw new ApiError(404, "NOT_FOUND", "Not found");
  return parsed.data.deploymentId;
}

export function createModelsController(
  auth: AuthService | undefined,
  models: ModelsService | undefined,
) {
  const listModels: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const context = contextOf(request.query);
    response
      .status(200)
      .json(await wired(models).listModels(actor.id, context));
  };

  const listDeployments: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const context = contextOf(request.query);
    response
      .status(200)
      .json(await wired(models).listDeployments(actor.id, context));
  };

  const deploy: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      DeploymentCreateRequestSchema,
      request.body,
      "Invalid deployment",
    );
    const deployment = await wired(models).deploy(actor.id, input);
    response.set("Cache-Control", "no-store");
    response.status(201).json({ deployment });
  };

  const setInference: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      DeploymentUpdateRequestSchema,
      request.body,
      "Invalid deployment",
    );
    const context = contextOf(request.query);
    const deploymentId = parseDeploymentId(request.params);
    const { deployment, changed } = await wired(models).setInference(
      actor.id,
      context,
      deploymentId,
      input.inferenceEnabled,
    );
    if (changed) {
      logEvent("info", "audit.deployment_inference_changed", {
        feature: "models",
        action: input.inferenceEnabled
          ? "DEPLOYMENT_ACTIVATED"
          : "DEPLOYMENT_DEACTIVATED",
        deploymentId,
        organizationId: context.organizationId,
        ...(context.groupId ? { groupId: context.groupId } : {}),
        actorUserId: actor.id,
      });
    }
    response.status(200).json({ deployment });
  };

  const remove: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const context = contextOf(request.query);
    const deploymentId = parseDeploymentId(request.params);
    const { deployment, changed } = await wired(models).remove(
      actor.id,
      context,
      deploymentId,
    );
    if (changed) {
      logEvent("info", "audit.deployment_removed", {
        feature: "models",
        action: "DEPLOYMENT_REMOVED",
        deploymentId,
        organizationId: context.organizationId,
        ...(context.groupId ? { groupId: context.groupId } : {}),
        actorUserId: actor.id,
      });
    }
    response.status(200).json({ deployment });
  };

  return { listModels, listDeployments, deploy, setInference, remove };
}
