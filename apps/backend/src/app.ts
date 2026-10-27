import express from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import type { DatabaseReadiness } from "./database.js";
import { parseGroupPage, type GroupService } from "./groups.js";
import type { BusinessPolicyService } from "./business-policies.js";
import type { InvoiceService } from "./invoices.js";
import type { PlatformAdministratorService } from "./platform-administrator.js";
import {
  createAuthOperations,
  profileResponse,
} from "./features/auth/routes.js";
import { ProfileUpdateSchema } from "./features/auth/schemas.js";
import {
  loadProfile,
  sessionTokenFromCookie,
} from "./features/auth/session.js";
import {
  GroupInputSchema,
  GroupMemberInputSchema,
  GroupUpdateSchema,
} from "./features/groups/schemas.js";
import {
  InvoiceListOptionsSchema,
  ResourceContextSchema,
} from "./features/invoices/schemas.js";
import {
  OrganizationInputSchema,
  MembershipCreateInputSchema,
  MembershipRoleInputSchema,
  ProvisionUserInputSchema,
} from "./features/platform/schemas.js";
import {
  BusinessPolicyCreateSchema,
  BusinessPolicyUpdateSchema,
} from "./features/policies/schemas.js";
import {
  ApiError,
  errorHandler,
  notFoundHandler,
  parseLegacy,
  parseWith,
  sendError,
} from "./http/errors.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import { API_PREFIX, mountOperations } from "./http/registry.js";

function requestOrigin(request: express.Request) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProtocol === "string" &&
    (forwardedProtocol === "http" || forwardedProtocol === "https")
      ? forwardedProtocol
      : request.protocol;

  return `${protocol}://${request.headers.host}`;
}

function unauthenticated() {
  return new AuthError(401, "Unauthenticated");
}

/** A route whose backing service is not wired answers like a missing session. */
function present<Service>(service: Service | undefined): Service {
  if (!service) throw unauthenticated();
  return service;
}

function parseResourceContext(input: unknown) {
  return parseLegacy(ResourceContextSchema, input, "Invalid resource context");
}

function parseInvoiceListQuery(input: unknown) {
  const context = parseResourceContext(input);
  const options = parseLegacy(
    InvoiceListOptionsSchema,
    input,
    "Invalid invoice query",
  );
  return { context, ...options };
}

// Identifier path parameters never contain a path separator: an encoded one
// (%2F, %5C) or a dot segment decodes into a "different route" that proxies and
// authorization layers did not see. Free-text parameters such as the policy
// version are not identifiers and are exempt.
const IDENTIFIER_PARAMS = ["organizationId", "groupId", "userId", "invoiceId"];

function rejectPathLikeIdentifier(
  _request: express.Request,
  _response: express.Response,
  next: express.NextFunction,
  value: unknown,
) {
  if (
    typeof value === "string" &&
    (/[/\\]/.test(value) || value === "." || value === "..")
  ) {
    next(new ApiError(404, "NOT_FOUND", "Route not found"));
    return;
  }
  next();
}

// Paths (relative to API_PREFIX) reachable while a temporary password is
// pending: profile, password change, login and logout. Probes and the OpenAPI
// document live outside the prefix and are never gated.
const ONBOARDING_PATHS = new Set([
  "/auth/profile",
  "/profile",
  "/auth/change-password",
  "/auth/logout",
  "/auth/login",
]);

export interface AppOptions {
  authRateLimiter?: AuthRateLimiter;
  groups?: GroupService;
  invoices?: InvoiceService;
  businessPolicies?: BusinessPolicyService;
  platformAdministrators?: PlatformAdministratorService;
  /**
   * Reverse-proxy hops trusted for `request.ip` (AUTH_TRUST_PROXY_HOPS).
   * Undefined keeps "trust proxy" off.
   */
  trustProxyHops?: number;
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
    trustProxyHops,
  }: AppOptions = {},
) {
  const app = express();

  app.disable("x-powered-by");
  // Routing and the credential guards below must agree on what a path is:
  // `/API/V1/...` and a trailing slash are different paths (404), never an
  // alias that skips a guard keyed on the exact prefix.
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  if (trustProxyHops !== undefined) app.set("trust proxy", trustProxyHops);
  app.use(express.json({ limit: "16kb" }));

  // Credentials are never mixed or substituted: Authorization (any scheme)
  // together with the session cookie is ambiguous, and Authorization alone is
  // not accepted yet (Bearer tokens arrive with RP0-16), so it never falls
  // back to a cookie session.
  app.use(API_PREFIX, (request, response, next) => {
    if (request.headers.authorization === undefined) {
      next();
      return;
    }
    if (sessionTokenFromCookie(request.headers.cookie) !== undefined) {
      sendError(
        response,
        400,
        "AMBIGUOUS_AUTH",
        "Send either an Authorization header or a session cookie, not both",
      );
      return;
    }
    sendError(response, 401, "UNAUTHENTICATED", "Unauthenticated");
  });

  app.use((request, response, next) => {
    if (
      !request.headers.cookie ||
      !["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
    ) {
      next();
      return;
    }

    if (request.headers.origin !== requestOrigin(request)) {
      sendError(response, 403, "FORBIDDEN_ORIGIN", "Origin not allowed");
      return;
    }

    next();
  });

  // Onboarding gate (API routes only): while a temporary password is pending,
  // only the paths above are reachable. The resolved profile is kept in
  // response.locals so the handler does not query it again.
  app.use(API_PREFIX, async (request, response, next) => {
    if (
      ONBOARDING_PATHS.has(request.path) ||
      !request.headers.cookie ||
      !auth
    ) {
      next();
      return;
    }
    try {
      const token = sessionTokenFromCookie(request.headers.cookie);
      if (!token) throw unauthenticated();
      const profile = await loadProfile(auth, token, response);
      if (profile.mustChangePassword) {
        throw new ApiError(
          403,
          "ONBOARDING_REQUIRED",
          "Password change required",
        );
      }
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

  const operations = createAuthOperations(auth, authRateLimiter);
  const api = express.Router({ caseSensitive: true, strict: true });
  api.use((request, response, next) => {
    response.locals.routeBase = request.baseUrl;
    next();
  });
  for (const name of IDENTIFIER_PARAMS) {
    api.param(name, rejectPathLikeIdentifier);
  }
  mountOperations(api, operations);

  const openApiDocument = buildOpenApiDocument(operations);
  app.get("/openapi.json", (_request, response) => {
    response.status(200).json(openApiDocument);
  });

  // Session profile for the legacy routes, from the gate's cache when present.
  async function currentProfile(
    request: express.Request,
    response: express.Response,
  ) {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !sessionToken) throw unauthenticated();
    return loadProfile(auth, sessionToken, response);
  }

  api.patch("/profile", async (request, response) => {
    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    if (!auth || !sessionToken) {
      throw unauthenticated();
    }

    const input = parseWith(
      ProfileUpdateSchema,
      request.body,
      "Invalid profile update",
    );
    response
      .status(200)
      .json(profileResponse(await auth.updateProfile(sessionToken, input)));
  });

  api.get("/groups", async (request, response) => {
    const groupService = present(groups);
    const profile = await currentProfile(request, response);
    response
      .status(200)
      .json({ groups: await groupService.listGroups(profile.id) });
  });

  api.get("/platform/organizations", async (request, response) => {
    const platform = present(platformAdministrators);
    const profile = await currentProfile(request, response);
    response.status(200).json({
      organizations: await platform.listOrganizations(profile.id),
    });
  });

  api.post("/platform/organizations", async (request, response) => {
    const platform = present(platformAdministrators);
    if (!platform.createOrganization) throw unauthenticated();
    const profile = await currentProfile(request, response);
    const organization = await platform.createOrganization(
      profile.id,
      parseLegacy(
        OrganizationInputSchema,
        request.body,
        "Invalid organization",
      ),
    );
    response.status(201).json({ organization });
  });

  api.post("/platform/users", async (request, response) => {
    const platform = present(platformAdministrators);
    if (!platform.provisionUser) throw unauthenticated();
    const profile = await currentProfile(request, response);
    const provisioned = await platform.provisionUser(
      profile.id,
      parseLegacy(
        ProvisionUserInputSchema,
        request.body,
        "Invalid user provision",
      ),
    );
    response.status(201).json(provisioned);
  });

  api.post(
    "/platform/organizations/:organizationId/members",
    async (request, response) => {
      const platform = present(platformAdministrators);
      const profile = await currentProfile(request, response);
      const input = parseLegacy(
        MembershipCreateInputSchema,
        request.body,
        "Invalid organization membership",
      );
      const membership = await platform.createMembership(
        profile.id,
        request.params.organizationId,
        input.userId,
        input.role,
      );
      response.status(201).json({ membership });
    },
  );

  api.patch(
    "/platform/organizations/:organizationId/members/:userId",
    async (request, response) => {
      const platform = present(platformAdministrators);
      const profile = await currentProfile(request, response);
      const input = parseLegacy(
        MembershipRoleInputSchema,
        request.body,
        "Invalid organization membership",
      );
      const membership = await platform.changeMembershipRole(
        profile.id,
        request.params.organizationId,
        request.params.userId,
        input.role,
      );
      response.status(200).json({ membership });
    },
  );

  api.delete(
    "/platform/organizations/:organizationId/members/:userId",
    async (request, response) => {
      const platform = present(platformAdministrators);
      const profile = await currentProfile(request, response);
      await platform.removeMembership(
        profile.id,
        request.params.organizationId,
        request.params.userId,
      );
      response.status(204).end();
    },
  );

  api.get("/invoices", async (request, response) => {
    const { context, q, cursor, limit } = parseInvoiceListQuery(request.query);
    const invoiceService = present(invoices);
    const profile = await currentProfile(request, response);
    response.status(200).json(
      await invoiceService.listInvoices(profile.id, context, {
        q,
        cursor,
        limit,
      }),
    );
  });

  api.get("/business-policies", async (request, response) => {
    const context = parseResourceContext(request.query);
    const policies = present(businessPolicies);
    const profile = await currentProfile(request, response);
    response.status(200).json({
      policies: await policies.listPolicies(profile.id, context),
    });
  });

  api.post("/business-policies", async (request, response) => {
    const context = parseResourceContext(request.query);
    const policies = present(businessPolicies);
    const profile = await currentProfile(request, response);
    const input = parseLegacy(
      BusinessPolicyCreateSchema,
      request.body,
      "Invalid business policy",
    );
    response.status(201).json({
      policy: await policies.createPolicy(profile.id, context, input),
    });
  });

  api.patch("/business-policies/:version", async (request, response) => {
    const context = parseResourceContext(request.query);
    const policies = present(businessPolicies);
    if (!request.params.version) throw unauthenticated();
    const profile = await currentProfile(request, response);
    response.status(200).json({
      policy: await policies.updatePolicy(
        profile.id,
        context,
        request.params.version,
        parseLegacy(
          BusinessPolicyUpdateSchema,
          request.body,
          "Invalid business policy",
        ),
      ),
    });
  });

  api.get("/invoices/:invoiceId", async (request, response) => {
    const { context } = parseInvoiceListQuery(request.query);
    const invoiceService = present(invoices);
    const profile = await currentProfile(request, response);
    response
      .status(200)
      .json(
        await invoiceService.getInvoice(
          profile.id,
          context,
          request.params.invoiceId,
        ),
      );
  });

  api.get(
    "/organizations/:organizationId/groups",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      const page = parseGroupPage(request.params.organizationId, request.query);
      response.setHeader("Cache-Control", "no-store");
      response
        .status(200)
        .json(
          await groupService.listOrganizationGroups(
            profile.id,
            request.params.organizationId,
            page,
          ),
        );
    },
  );

  api.post(
    "/organizations/:organizationId/groups",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      const group = await groupService.createGroup(
        profile.id,
        request.params.organizationId,
        parseLegacy(GroupInputSchema, request.body, "Invalid group input"),
      );
      response.status(201).json({ group });
    },
  );

  api.patch(
    "/organizations/:organizationId/groups/:groupId",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      const group = await groupService.updateGroup(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        parseLegacy(GroupUpdateSchema, request.body, "Invalid group update"),
      );
      response.status(200).json({ group });
    },
  );

  api.delete(
    "/organizations/:organizationId/groups/:groupId",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      await groupService.deleteGroup(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
      );
      response.status(204).end();
    },
  );

  api.post(
    "/organizations/:organizationId/groups/:groupId/members",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      const group = await groupService.addMember(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        parseLegacy(
          GroupMemberInputSchema,
          request.body,
          "Invalid group member",
        ).userId,
      );
      response.status(200).json({ group });
    },
  );

  api.delete(
    "/organizations/:organizationId/groups/:groupId/members/:userId",
    async (request, response) => {
      const groupService = present(groups);
      const profile = await currentProfile(request, response);
      await groupService.removeMember(
        profile.id,
        request.params.organizationId,
        request.params.groupId,
        request.params.userId,
      );
      response.status(204).end();
    },
  );

  app.use(API_PREFIX, api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
