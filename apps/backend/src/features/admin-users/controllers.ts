import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import { AdminUserCreateRequestSchema } from "./schemas.js";
import type { AdminUserService } from "./services.js";

function wired(service: AdminUserService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

export function createAdminUserController(
  auth: AuthService | undefined,
  adminUsers: AdminUserService | undefined,
) {
  const create: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    // Same order as every other write: the body is validated first, then the
    // authority is checked (here and again inside the transaction).
    const input = parseWith(
      AdminUserCreateRequestSchema,
      request.body,
      "Invalid user",
    );
    if (!actor.isPlatformAdministrator) {
      throw new ApiError(403, "FORBIDDEN", "Forbidden");
    }
    const created = await wired(adminUsers).createUser(actor.id, input);
    // The temporary password is shown once and must never be cached.
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(created);
  };

  return { create };
}
