import express, { type ErrorRequestHandler } from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import { parseRut } from "./rut.js";
import type { DatabaseReadiness } from "./database.js";
import {
  parseGroupPage,
  type GroupInput,
  type GroupService,
  type GroupUpdate,
} from "./groups.js";
import type { BusinessPolicyService } from "./business-policies.js";
import type { InvoiceService } from "./invoices.js";
import type { ResourceContext } from "./resource-context.js";
import { OrganizationRole } from "./generated/prisma/client.js";
import type { PlatformAdministratorService } from "./platform-administrator.js";
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

function parseOrganizationMembershipInput(
  input: unknown,
  requiresUserId: boolean,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError(400, "Invalid organization membership");
  }

  const record = input as Record<string, unknown>;
  const expectedKeys = requiresUserId ? ["userId", "role"] : ["role"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record)) ||
    (requiresUserId &&
      (typeof record.userId !== "string" || !record.userId.trim())) ||
    (record.role !== OrganizationRole.ADMIN &&
      record.role !== OrganizationRole.USER)
  ) {
    throw new AuthError(400, "Invalid organization membership");
  }

  return {
    userId: requiresUserId ? (record.userId as string).trim() : undefined,
    role: record.role,
  } as { userId?: string; role: OrganizationRole };
}

function parseOrganizationInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AuthError(400, "Invalid organization");
  const { name, slug, description, ...extra } = input as Record<
    string,
    unknown
  >;
  if (
    Object.keys(extra).length ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    typeof slug !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    (description !== undefined &&
      description !== null &&
      (typeof description !== "string" || description.trim().length > 1000))
  )
    throw new AuthError(400, "Invalid organization");
  return {
    name: name.trim(),
    slug,
    ...(description === undefined
      ? {}
      : {
          description: description === null ? null : description.trim() || null,
        }),
  };
}

function parseProvisionUserInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AuthError(400, "Invalid user provision");
  const { name, rut, organizationId, role, ...extra } = input as Record<
    string,
    unknown
  >;
  if (
    Object.keys(extra).length ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    typeof organizationId !== "string" ||
    !organizationId.trim() ||
    (role !== OrganizationRole.ADMIN && role !== OrganizationRole.USER)
  )
    throw new AuthError(400, "Invalid user provision");
  let canonicalRut: string;
  try {
    canonicalRut = parseRut(rut);
  } catch {
    throw new AuthError(400, "Invalid user provision");
  }
  return {
    name: name.trim(),
    rut: canonicalRut,
    organizationId: organizationId.trim(),
    role,
  };
}

function parsePasswordChange(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AuthError(400, "Invalid password change");
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.currentPassword !== "string" ||
    typeof record.newPassword !== "string"
  )
    throw new AuthError(400, "Invalid password change");
  return {
    currentPassword: record.currentPassword,
    newPassword: record.newPassword,
  };
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

function parseInvoiceListQuery(input: unknown) {
  const query = input as Record<string, unknown>;
  const context = parseResourceContext(query);
  const q = query.q === undefined ? "" : query.q;
  const cursor = query.cursor === undefined ? undefined : query.cursor;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (
    typeof q !== "string" ||
    q.trim().length > 120 ||
    (cursor !== undefined && (typeof cursor !== "string" || !cursor)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new AuthError(400, "Invalid invoice query");
  }
  return { context, q: q.trim(), cursor, limit };
}

function parseBusinessPolicy(input: unknown, requiresVersion: boolean) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AuthError(400, "Invalid business policy");
  }
  const record = input as Record<string, unknown>;
  const expectedKeys = requiresVersion
    ? ["version", "manualReviewThreshold"]
    : ["manualReviewThreshold"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record)) ||
    (requiresVersion &&
      (typeof record.version !== "string" ||
        !record.version.trim() ||
        record.version.trim().length > 120)) ||
    typeof record.manualReviewThreshold !== "number" ||
    !Number.isFinite(record.manualReviewThreshold) ||
    record.manualReviewThreshold < 0 ||
    record.manualReviewThreshold > 1
  ) {
    throw new AuthError(400, "Invalid business policy");
  }
  return {
    ...(requiresVersion ? { version: (record.version as string).trim() } : {}),
    manualReviewThreshold: record.manualReviewThreshold,
  };
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
      isPlatformAdministrator: profile.isPlatformAdministrator,
      memberships: profile.memberships,
    },
  };
}

export interface AppOptions {
  authRateLimiter?: AuthRateLimiter;
  groups?: GroupService;
  invoices?: InvoiceService;
  businessPolicies?: BusinessPolicyService;
  platformAdministrators?: PlatformAdministratorService;
}

export function createApp(
  database: DatabaseReadiness,
  auth?: AuthService,
  {
    authRateLimiter = createAuthRateLimiter(),
    groups,
    invoices,
    businessPolicies,
    platformAdministrators,
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

  app.use(async (request, _response, next) => {
    const permitted =
      request.path === "/profile" ||
      request.path === "/auth/logout" ||
      request.path === "/auth/change-password" ||
      request.path === "/auth/login" ||
      request.path === "/health/live" ||
      request.path === "/health/ready";
    if (permitted || !request.headers.cookie || !auth) return next();
    try {
      const token = sessionTokenFromCookie(request.headers.cookie);
      if (!token) throw new AuthError(401, "Unauthorized");
      const profile = await auth.getProfile(token);
      if (profile.mustChangePassword)
        throw new AuthError(403, "Password change required");
      next();
    } catch (error) {
      next(error);
    }
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

  app.post("/auth/change-password", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !auth.changePassword || !sessionToken)
      throw new AuthError(401, "Unauthorized");
    await auth.changePassword(sessionToken, parsePasswordChange(request.body));
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

  app.get("/platform/organizations", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !platformAdministrators || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }

    const profile = await auth.getProfile(sessionToken);
    response.status(200).json({
      organizations: await platformAdministrators.listOrganizations(profile.id),
    });
  });

  app.post("/platform/organizations", async (request, response) => {
    const token = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !platformAdministrators?.createOrganization || !token)
      throw new AuthError(401, "Unauthorized");
    const organization = await platformAdministrators.createOrganization(
      (await auth.getProfile(token)).id,
      parseOrganizationInput(request.body),
    );
    response.status(201).json({ organization });
  });

  app.post("/platform/users", async (request, response) => {
    const token = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !platformAdministrators?.provisionUser || !token)
      throw new AuthError(401, "Unauthorized");
    const provisioned = await platformAdministrators.provisionUser(
      (await auth.getProfile(token)).id,
      parseProvisionUserInput(request.body),
    );
    response.status(201).json(provisioned);
  });

  app.post(
    "/platform/organizations/:organizationId/members",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !platformAdministrators || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      const input = parseOrganizationMembershipInput(request.body, true);
      const membership = await platformAdministrators.createMembership(
        profile.id,
        request.params.organizationId,
        input.userId!,
        input.role,
      );
      response.status(201).json({ membership });
    },
  );

  app.patch(
    "/platform/organizations/:organizationId/members/:userId",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !platformAdministrators || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      const input = parseOrganizationMembershipInput(request.body, false);
      const membership = await platformAdministrators.changeMembershipRole(
        profile.id,
        request.params.organizationId,
        request.params.userId,
        input.role,
      );
      response.status(200).json({ membership });
    },
  );

  app.delete(
    "/platform/organizations/:organizationId/members/:userId",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !platformAdministrators || !sessionToken) {
        throw new AuthError(401, "Unauthorized");
      }

      const profile = await auth.getProfile(sessionToken);
      await platformAdministrators.removeMembership(
        profile.id,
        request.params.organizationId,
        request.params.userId,
      );
      response.status(204).end();
    },
  );

  app.get("/invoices", async (request, response) => {
    const { context, q, cursor, limit } = parseInvoiceListQuery(request.query);
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !invoices || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }
    const profile = await auth.getProfile(sessionToken);
    response
      .status(200)
      .json(
        await invoices.listInvoices(profile.id, context, { q, cursor, limit }),
      );
  });

  app.get("/business-policies", async (request, response) => {
    const context = parseResourceContext(request.query);
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !businessPolicies || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }
    const profile = await auth.getProfile(sessionToken);
    response.status(200).json({
      policies: await businessPolicies.listPolicies(profile.id, context),
    });
  });

  app.post("/business-policies", async (request, response) => {
    const context = parseResourceContext(request.query);
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !businessPolicies || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }
    const profile = await auth.getProfile(sessionToken);
    const input = parseBusinessPolicy(request.body, true);
    response.status(201).json({
      policy: await businessPolicies.createPolicy(profile.id, context, {
        version: input.version!,
        manualReviewThreshold: input.manualReviewThreshold,
      }),
    });
  });

  app.patch("/business-policies/:version", async (request, response) => {
    const context = parseResourceContext(request.query);
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (
      !auth ||
      !businessPolicies ||
      !sessionToken ||
      !request.params.version
    ) {
      throw new AuthError(401, "Unauthorized");
    }
    const profile = await auth.getProfile(sessionToken);
    response.status(200).json({
      policy: await businessPolicies.updatePolicy(
        profile.id,
        context,
        request.params.version,
        parseBusinessPolicy(request.body, false),
      ),
    });
  });

  app.get("/invoices/:invoiceId", async (request, response) => {
    const { context } = parseInvoiceListQuery(request.query);
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !invoices || !sessionToken) {
      throw new AuthError(401, "Unauthorized");
    }
    const profile = await auth.getProfile(sessionToken);
    response
      .status(200)
      .json(
        await invoices.getInvoice(
          profile.id,
          context,
          request.params.invoiceId,
        ),
      );
  });

  app.get(
    "/organizations/:organizationId/groups",
    async (request, response) => {
      const sessionToken = sessionTokenFromCookie(request.headers.cookie);
      if (!auth || !groups || !sessionToken)
        throw new AuthError(401, "Unauthorized");
      const profile = await auth.getProfile(sessionToken);
      const page = parseGroupPage(request.params.organizationId, request.query);
      response.setHeader("Cache-Control", "no-store");
      response
        .status(200)
        .json(
          await groups.listOrganizationGroups(
            profile.id,
            request.params.organizationId,
            page,
          ),
        );
    },
  );

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
    request,
    response,
    _next,
  ) => {
    if (error instanceof AuthError) {
      response
        .status(error.status)
        .json({ status: "error", message: error.message });
      return;
    }

    const bodyError = error as { type?: unknown; status?: unknown } | null;
    if (bodyError?.type === "entity.parse.failed") {
      response
        .status(400)
        .json({ status: "error", message: "Invalid JSON body" });
      return;
    }
    if (bodyError?.type === "entity.too.large") {
      response
        .status(413)
        .json({ status: "error", message: "Request body too large" });
      return;
    }

    // Any other client error raised by Express or middleware (for example a
    // malformed URL escape) keeps its 4xx status with a generic message.
    const clientError = error as { status?: unknown; statusCode?: unknown };
    const clientStatus = [clientError?.status, clientError?.statusCode].find(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 400 &&
        value <= 499,
    );
    if (clientStatus !== undefined) {
      response
        .status(clientStatus)
        .json({ status: "error", message: "Bad request" });
      return;
    }

    console.error("Unhandled request error", error);
    response.status(500).json({ status: "error" });
  };

  app.use(errorHandler);

  return app;
}
