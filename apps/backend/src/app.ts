import express, { type ErrorRequestHandler } from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import type { DatabaseReadiness } from "./database.js";
import type { GroupInput, GroupService, GroupUpdate } from "./groups.js";
import type { ResourceContext, ResourceService } from "./resources.js";

const SESSION_COOKIE_NAME = "invoiceops_session";
const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_CLIENT_IP = "unknown";

function sessionTokenFromCookie(header: string | undefined) {
  if (!header) {
    return undefined;
  }

  return header
    .split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === SESSION_COOKIE_NAME)?.[1];
}

function parseProfileUpdate(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError(400, "Invalid profile update");
  }

  const entries = Object.entries(input);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, value]) =>
        (key !== "email" && key !== "username") ||
        (value !== null && typeof value !== "string"),
    )
  ) {
    throw new AuthError(400, "Invalid profile update");
  }

  return Object.fromEntries(entries) as {
    email?: string | null;
    username?: string | null;
  };
}

function parseGroupInput(input: unknown): GroupInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError(400, "Invalid group input");
  }

  const { name, description, ...extra } = input as Record<string, unknown>;
  if (
    Object.keys(extra).length > 0 ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    (description !== undefined &&
      description !== null &&
      typeof description !== "string") ||
    (typeof description === "string" && description.trim().length > 1_000)
  ) {
    throw new AuthError(400, "Invalid group input");
  }

  return {
    name: name.trim(),
    ...(description === undefined
      ? {}
      : {
          description: description === null ? null : description.trim() || null,
        }),
  };
}

function parseGroupUpdate(input: unknown): GroupUpdate {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError(400, "Invalid group update");
  }

  const entries = Object.entries(input);
  if (
    entries.length === 0 ||
    entries.some(
      ([key, value]) =>
        (key !== "name" && key !== "description") ||
        (key === "name" &&
          (typeof value !== "string" ||
            !value.trim() ||
            value.trim().length > 120)) ||
        (key === "description" &&
          value !== null &&
          (typeof value !== "string" || value.trim().length > 1_000)),
    )
  ) {
    throw new AuthError(400, "Invalid group update");
  }

  return Object.fromEntries(
    entries.map(([key, value]) => [
      key,
      typeof value === "string" ? value.trim() || null : value,
    ]),
  ) as GroupUpdate;
}

function parseMemberInput(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    typeof (input as { userId?: unknown }).userId !== "string" ||
    !(input as { userId: string }).userId.trim()
  ) {
    throw new AuthError(400, "Invalid group member");
  }

  return (input as { userId: string }).userId.trim();
}

function parseResourceContext(input: unknown): ResourceContext {
  const { organizationId, ownerType, ownerId } = input as Record<
    string,
    unknown
  >;
  if (
    typeof organizationId !== "string" ||
    !organizationId ||
    (ownerType !== "user" && ownerType !== "group") ||
    typeof ownerId !== "string" ||
    !ownerId
  ) {
    throw new AuthError(400, "Invalid resource context");
  }

  return { organizationId, ownerType, ownerId };
}

function requestOrigin(request: express.Request) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProtocol === "string" &&
    (forwardedProtocol === "http" || forwardedProtocol === "https")
      ? forwardedProtocol
      : request.protocol;

  return `${protocol}://${request.headers.host}`;
}

function profileResponse(
  profile: Awaited<ReturnType<AuthService["getProfile"]>>,
) {
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      rut: profile.rut,
      email: profile.email,
      username: profile.username,
      memberships: profile.memberships,
    },
  };
}

export interface AppOptions {
  authRateLimiter?: AuthRateLimiter;
  groups?: GroupService;
  resources?: ResourceService;
}

export function createApp(
  database: DatabaseReadiness,
  auth?: AuthService,
  {
    authRateLimiter = createAuthRateLimiter(),
    groups,
    resources,
  }: AppOptions = {},
) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.use((request, response, next) => {
    if (
      !request.headers.cookie ||
      !["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
    ) {
      next();
      return;
    }

    if (request.headers.origin !== requestOrigin(request)) {
      response.status(403).json({ status: "error", message: "Forbidden" });
      return;
    }

    next();
  });

  app.get("/health/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    let databaseReady = false;

    try {
      databaseReady = await database.isReady();
    } catch {
      databaseReady = false;
    }

    if (!databaseReady) {
      response.status(503).json({ status: "unavailable" });
      return;
    }

    response.status(200).json({ status: "ok" });
  });

  const limitAuthAttempts: express.RequestHandler = (
    request,
    response,
    next,
  ) => {
    if (!authRateLimiter.allow(request.ip ?? UNKNOWN_CLIENT_IP)) {
      response.status(429).json({
        status: "error",
        message: "Too many attempts. Try again later.",
      });
      return;
    }

    next();
  };

  app.post("/auth/signup", limitAuthAttempts, async (request, response) => {
    if (!auth) {
      response.status(503).json({ status: "unavailable" });
      return;
    }

    const user = await auth.signUp(request.body);
    response.status(201).json({ user });
  });

  app.post("/auth/login", limitAuthAttempts, async (request, response) => {
    if (!auth) {
      response.status(503).json({ status: "unavailable" });
      return;
    }

    const { sessionToken, user } = await auth.login(request.body);
    response.cookie(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    response.status(200).json({ user });
  });

  app.post("/auth/logout", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    await auth.logout(sessionToken);
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    response.status(204).end();
  });

  app.get("/profile", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    response
      .status(200)
      .json(profileResponse(await auth.getProfile(sessionToken)));
  });

  app.patch("/profile", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    const input = parseProfileUpdate(request.body);
    response
      .status(200)
      .json(profileResponse(await auth.updateProfile(sessionToken, input)));
  });

  app.get("/groups", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !groups || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    const profile = await auth.getProfile(sessionToken);
    response.status(200).json({ groups: await groups.listGroups(profile.id) });
  });

  app.get("/resources", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !resources || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    const profile = await auth.getProfile(sessionToken);
    const context = parseResourceContext(request.query);
    response
      .status(200)
      .json({ resources: await resources.listResources(profile.id, context) });
  });

  app.post(
    "/organizations/:organizationId/groups",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      const group = await groups.createGroup(
        profile.id,
        request.params.organizationId,
        parseGroupInput(request.body),
      );
      response.status(201).json({ group });
    },
  );

  app.patch(
    "/organizations/:organizationId/groups/:groupId",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      const group = await groups.updateGroup(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        parseGroupUpdate(request.body),
      );
      response.status(200).json({ group });
    },
  );

  app.delete(
    "/organizations/:organizationId/groups/:groupId",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      await groups.deleteGroup(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
      );
      response.status(204).end();
    },
  );

  app.post(
    "/organizations/:organizationId/groups/:groupId/members",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      const group = await groups.addMember(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        parseMemberInput(request.body),
      );
      response.status(200).json({ group });
    },
  );

  app.delete(
    "/organizations/:organizationId/groups/:groupId/members/:userId",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      await groups.removeMember(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        request.params.userId,
      );
      response.status(204).end();
    },
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    if (error instanceof AuthError) {
      response
        .status(error.status)
        .json({ status: "error", message: error.message });
      return;
    }

    console.error("Unhandled request error", error);
    response.status(500).json({ status: "error" });
  };

  app.use(errorHandler);

  return app;
}
