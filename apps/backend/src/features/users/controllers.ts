import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import { UserProvisionRequestSchema } from "./schemas.js";
import type { UserService } from "./services.js";

function wired(service: UserService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

export function createUserController(
  auth: AuthService | undefined,
  users: UserService | undefined,
) {
  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const result = await wired(users).listUsers(
      actor.id,
      String(request.params.organizationId),
    );
    response.status(200).json({ users: result });
  };

  const provision: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      UserProvisionRequestSchema,
      request.body,
      "Invalid user provision",
    );
    const provisioned = await wired(users).provisionUser(
      actor.id,
      String(request.params.organizationId),
      input,
    );
    // The temporary password is shown once and must never be cached.
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(provisioned);
  };

  return { list, provision };
}
