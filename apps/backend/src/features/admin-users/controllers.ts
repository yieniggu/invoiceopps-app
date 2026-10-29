import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import { logEvent } from "../../http/logging.js";
import {
  AdminUserCreateRequestSchema,
  AdminUserListQuerySchema,
  AdminUserParamsSchema,
  AdminUserPasswordResetRequestSchema,
  AdminUserUpdateRequestSchema,
} from "./schemas.js";
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

  const setDisabled =
    (action: "deactivate" | "reactivate"): RequestHandler =>
    async (request, response) => {
      const actor = await requireSessionProfile(auth, request, response);
      const { userId } = parseWith(
        AdminUserParamsSchema,
        request.params,
        "Invalid user",
      );
      if (!actor.isPlatformAdministrator) {
        throw new ApiError(403, "FORBIDDEN", "Forbidden");
      }
      const service = wired(adminUsers);
      const { result, changed } =
        action === "deactivate"
          ? await service.deactivateUser(actor.id, userId)
          : await service.reactivateUser(actor.id, userId);
      if (changed) {
        // Success-only audit event; identifiers only.
        logEvent(
          "info",
          action === "deactivate"
            ? "audit.user_deactivated"
            : "audit.user_reactivated",
          {
            feature: "admin-users",
            action,
            actorUserId: actor.id,
            targetUserId: userId,
          },
        );
      }
      response.status(200).json(result);
    };

  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const query = parseWith(
      AdminUserListQuerySchema,
      request.query,
      "Invalid query",
    );
    if (!actor.isPlatformAdministrator) {
      throw new ApiError(403, "FORBIDDEN", "Forbidden");
    }
    response
      .status(200)
      .json(await wired(adminUsers).listUsers(actor.id, query));
  };

  const detail: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const { userId } = parseWith(
      AdminUserParamsSchema,
      request.params,
      "Invalid user",
    );
    if (!actor.isPlatformAdministrator) {
      throw new ApiError(403, "FORBIDDEN", "Forbidden");
    }
    response
      .status(200)
      .json(await wired(adminUsers).getUser(actor.id, userId));
  };

  const update: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const { userId } = parseWith(
      AdminUserParamsSchema,
      request.params,
      "Invalid user",
    );
    const input = parseWith(
      AdminUserUpdateRequestSchema,
      request.body,
      "Invalid user",
    );
    if (!actor.isPlatformAdministrator) {
      throw new ApiError(403, "FORBIDDEN", "Forbidden");
    }
    const { result, changed } = await wired(adminUsers).updateUser(
      actor.id,
      userId,
      input,
    );
    if (changed) {
      // Success-only audit event; identifiers only, never the name or RUT.
      logEvent("info", "audit.user_updated", {
        feature: "admin-users",
        action: "update",
        actorUserId: actor.id,
        targetUserId: userId,
      });
    }
    response.status(200).json(result);
  };

  const resetPassword: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const { userId } = parseWith(
      AdminUserParamsSchema,
      request.params,
      "Invalid user",
    );
    const input = parseWith(
      AdminUserPasswordResetRequestSchema,
      request.body,
      "Invalid password reset",
    );
    if (!actor.isPlatformAdministrator) {
      throw new ApiError(403, "FORBIDDEN", "Forbidden");
    }
    const result = await wired(adminUsers).resetPassword(
      actor.id,
      userId,
      input,
    );
    // The temporary password is shown once and must never be cached or logged.
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(result);
  };

  return {
    list,
    detail,
    update,
    resetPassword,
    create,
    deactivate: setDisabled("deactivate"),
    reactivate: setDisabled("reactivate"),
  };
}
