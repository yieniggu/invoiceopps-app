import express from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import type { Database, DatabaseReadiness } from "./database.js";
import type { BusinessPolicyService } from "./business-policies.js";
import type { InvoiceService } from "./invoices.js";
import { createAuthOperations } from "./features/auth/routes.js";
import {
  loadProfile,
  sessionTokenFromCookie,
} from "./features/auth/session.js";
import { createAdminUserOperations } from "./features/admin-users/routes.js";
import {
  createAdminUserService,
  type AdminUserService,
} from "./features/admin-users/services.js";
import { createGroupOperations } from "./features/groups/routes.js";
import {
  createGroupService,
  type GroupCatalogService,
  type GroupService,
} from "./features/groups/services.js";
import {
  InvoiceListOptionsSchema,
  ResourceContextSchema,
} from "./features/invoices/schemas.js";
import { createInvoiceOperations } from "./features/invoices/routes.js";
import {
  createInvoiceCreateService,
  type InvoiceCreateService,
} from "./features/invoices/services.js";
import { createOrganizationOperations } from "./features/orgs/routes.js";
import {
  createOrganizationService,
  type OrganizationService,
} from "./features/orgs/services.js";
import { createUserOperations } from "./features/users/routes.js";
import {
  createUserService,
  type UserService,
} from "./features/users/services.js";
import {
  BusinessPolicyCreateSchema,
  BusinessPolicyUpdateSchema,
} from "./features/policies/schemas.js";
import {
  ApiError,
  errorHandler,
  notFoundHandler,
  parseLegacy,
  sendError,
} from "./http/errors.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import {
  API_PREFIX,
  createJsonBodyParser,
  mountOperations,
} from "./http/registry.js";

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
  /** Backs the undocumented GET /api/v1/groups. */
  groups?: GroupCatalogService;
  /**
   * Documented operations default to services built on `database.prisma`;
   * these override them (tests inject fakes).
   */
  organizations?: OrganizationService;
  users?: UserService;
  adminUsers?: AdminUserService;
  groupAdministration?: GroupService;
  /** Backs the documented POST /api/v1/invoices (the GET routes use `invoices`). */
  invoiceCreation?: InvoiceCreateService;
  invoices?: InvoiceService;
  businessPolicies?: BusinessPolicyService;
  /**
   * Reverse-proxy hops trusted for `request.ip` (AUTH_TRUST_PROXY_HOPS).
   * Undefined keeps "trust proxy" off.
   */
  trustProxyHops?: number;
}

export function createApp(
  database: DatabaseReadiness & Partial<Pick<Database, "prisma">>,
  auth?: AuthService,
  {
    authRateLimiter = createAuthRateLimiter(),
    groups,
    organizations,
    users,
    adminUsers,
    groupAdministration,
    invoiceCreation,
    invoices,
    businessPolicies,
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
  // Documented operations need the Prisma client; without it they are still
  // mounted and documented but answer like a missing session. They are built
  // first because the body parser picks its limit from them.
  const { prisma } = database;
  const operations = [
    ...createAuthOperations(auth, authRateLimiter),
    ...createOrganizationOperations(
      auth,
      organizations ?? (prisma && createOrganizationService(prisma)),
    ),
    ...createUserOperations(
      auth,
      users ?? (prisma && createUserService(prisma)),
    ),
    ...createAdminUserOperations(
      auth,
      adminUsers ?? (prisma && createAdminUserService(prisma)),
    ),
    ...createGroupOperations(
      auth,
      groupAdministration ?? (prisma && createGroupService(prisma)),
    ),
    ...createInvoiceOperations(
      auth,
      invoiceCreation ?? (prisma && createInvoiceCreateService(prisma)),
    ),
  ];
  app.use(createJsonBodyParser(operations));

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

  api.get("/groups", async (request, response) => {
    const groupService = present(groups);
    const profile = await currentProfile(request, response);
    response
      .status(200)
      .json({ groups: await groupService.listGroups(profile.id) });
  });

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

  app.use(API_PREFIX, api);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
