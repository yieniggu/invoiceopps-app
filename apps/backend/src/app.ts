import express from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import type { Database, DatabaseReadiness } from "./database.js";
import type { Readiness } from "./migrations.js";
import {
  ResourceContextSchema,
  type BusinessPolicyService,
} from "./business-policies.js";
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
import { BEARER_SECRET_LOCAL } from "./features/api-tokens/actor.js";
import { createApiTokenAuthenticator } from "./features/api-tokens/bearer.js";
import {
  createSessionIntrospectionHandler,
  createSessionIntrospectionService,
  SESSION_INTROSPECTION_PATH,
  type SessionIntrospectionService,
} from "./features/api-tokens/session-introspection.js";
import {
  createApiTokenIntrospectionService,
  createIntrospectionHandler,
  createServiceCredentialGuard,
  INTROSPECTION_PATH,
  type ApiTokenIntrospectionService,
} from "./features/api-tokens/introspection.js";
import {
  createExchangeHandler,
  AUTHORIZE_MAX_PER_MINUTE,
  AUTHORIZE_WINDOW_MS,
  createMlflowSsoOperations,
  AUTHORIZE_PATH,
  createRevokeHandler,
  EXCHANGE_PATH,
  REVOKE_PATH,
} from "./features/mlflow-sso/routes.js";
import {
  createMlflowSsoService,
  type MlflowSsoService,
} from "./features/mlflow-sso/service.js";
import { createApiTokenOperations } from "./features/api-tokens/routes.js";
import {
  createApiTokenService,
  TOKEN_ISSUANCE_MAX_PER_WINDOW,
  type ApiTokenService,
} from "./features/api-tokens/services.js";
import { createGroupOperations } from "./features/groups/routes.js";
import {
  createGroupService,
  type GroupCatalogService,
  type GroupService,
} from "./features/groups/services.js";
import { createInvoiceOperations } from "./features/invoices/routes.js";
import {
  createInvoiceCreateService,
  createInvoiceDeleteService,
  createInvoiceReadService,
  type InvoiceCreateService,
  type InvoiceDeleteService,
  type InvoiceReadService,
} from "./features/invoices/services.js";
import { createModelsOperations } from "./features/models/routes.js";
import {
  createModelsService,
  type ModelsService,
} from "./features/models/services.js";
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
import { createDocsRouter } from "./http/docs.js";
import { buildOpenApiDocument } from "./http/openapi.js";
import {
  API_PREFIX,
  createBearerRouteMatcher,
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

// Identifier path parameters never contain a path separator: an encoded one
// (%2F, %5C) or a dot segment decodes into a "different route" that proxies and
// authorization layers did not see. Free-text parameters such as the policy
// version are not identifiers and are exempt.
const IDENTIFIER_PARAMS = [
  "organizationId",
  "groupId",
  "userId",
  "invoiceId",
  "tokenId",
  "deploymentId",
];

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

// Authorization: Bearer <secret> with exactly one non-blank value. Whether the
// secret is a known token is decided by the authenticator, not here.
const BEARER_AUTHORIZATION = /^Bearer ([^\s]{1,512})$/i;

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
  /**
   * Per-user limiter of POST /api/v1/api-tokens (20 attempts per 15 minutes by
   * default). server.ts disables it together with the auth limiter.
   */
  apiTokenIssuanceLimiter?: AuthRateLimiter;
  /** Per-session limiter of GET /api/v1/mlflow/authorize (30 per minute by default). */
  mlflowAuthorizeLimiter?: AuthRateLimiter;
  /**
   * Per-IP limiter of the 401s of the private /internal routes (20 wrong
   * credentials per minute by default). server.ts disables it together with
   * the auth limiter.
   */
  internalAuthLimiter?: AuthRateLimiter;
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
  /** Backs the documented POST /api/v1/invoices. */
  invoiceCreation?: InvoiceCreateService;
  /** Backs the documented GET /api/v1/invoices and /api/v1/invoices/{invoiceId}. */
  invoiceReads?: InvoiceReadService;
  /** Backs the documented DELETE /api/v1/invoices/{invoiceId}. */
  invoiceDeletion?: InvoiceDeleteService;
  businessPolicies?: BusinessPolicyService;
  /** Backs the documented /api/v1/api-tokens operations. */
  apiTokens?: ApiTokenService;
  /** Backs the documented /api/v1/models and /api/v1/deployments operations (MLOPS-05). */
  models?: ModelsService;
  /** Backs the private POST /internal/api-tokens/introspect (MLOPS-01). */
  apiTokenIntrospection?: ApiTokenIntrospectionService;
  /** Backs the private POST /internal/sessions/introspect (MLOPS-02). */
  sessionIntrospection?: SessionIntrospectionService;
  /** Backs GET /api/v1/mlflow/authorize and the private exchange/revoke routes. */
  mlflowSso?: MlflowSsoService;
  /**
   * The only redirect_uri the authorize endpoint accepts
   * (MLFLOW_PUBLIC_URL + callback path). Unset: the endpoint answers 503.
   */
  mlflowCallbackUrl?: string;
  /**
   * Service credential of the private /internal routes
   * (INTERNAL_INTROSPECTION_SECRET). Missing: every request to them is refused
   * (fail closed). A set but weak value (too short, with whitespace or not
   * random-looking) is rejected at startup, so it never reaches this option.
   */
  internalServiceSecret?: string;
  /**
   * Reverse-proxy hops trusted for `request.ip` (AUTH_TRUST_PROXY_HOPS).
   * Undefined keeps "trust proxy" off.
   */
  trustProxyHops?: number;
  /**
   * Browser-facing origin (PUBLIC_ORIGIN). When set, cookie-bearing writes
   * must send exactly this `Origin`; Host and X-Forwarded-Proto are ignored.
   */
  publicOrigin?: string;
}

export function createApp(
  database: DatabaseReadiness & Partial<Pick<Database, "prisma">>,
  auth?: AuthService,
  {
    authRateLimiter = createAuthRateLimiter(),
    apiTokenIssuanceLimiter = createAuthRateLimiter({
      maxAttempts: TOKEN_ISSUANCE_MAX_PER_WINDOW,
    }),
    mlflowAuthorizeLimiter = createAuthRateLimiter({
      maxAttempts: AUTHORIZE_MAX_PER_MINUTE,
      windowMs: AUTHORIZE_WINDOW_MS,
    }),
    internalAuthLimiter,
    groups,
    organizations,
    users,
    adminUsers,
    groupAdministration,
    invoiceCreation,
    invoiceReads,
    invoiceDeletion,
    businessPolicies,
    apiTokens,
    models,
    apiTokenIntrospection,
    sessionIntrospection,
    mlflowSso,
    mlflowCallbackUrl,
    internalServiceSecret,
    trustProxyHops,
    publicOrigin,
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
  const tokenAuthenticator = prisma && createApiTokenAuthenticator(prisma);
  const ssoService = mlflowSso ?? (prisma && createMlflowSsoService(prisma));
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
      invoiceReads ?? (prisma && createInvoiceReadService(prisma)),
      invoiceDeletion ?? (prisma && createInvoiceDeleteService(prisma)),
      tokenAuthenticator,
    ),
    ...createApiTokenOperations(
      auth,
      apiTokens ?? (prisma && createApiTokenService(prisma)),
      apiTokenIssuanceLimiter,
    ),
    ...createModelsOperations(
      auth,
      models ?? (prisma && createModelsService(prisma)),
    ),
    ...createMlflowSsoOperations(
      ssoService,
      mlflowCallbackUrl,
      mlflowAuthorizeLimiter,
    ),
  ];
  const acceptsBearer = createBearerRouteMatcher(operations);
  app.use(createJsonBodyParser(operations));

  // Credentials are never mixed or substituted: Authorization (any scheme)
  // together with the session cookie is ambiguous. Authorization alone is
  // accepted only as a well-formed Bearer on the operations flagged `bearer`
  // (the four invoice operations); anywhere else it is a 401 and never falls
  // back to a cookie session. An accepted secret is left in response.locals
  // for the operation to authenticate.
  app.use(API_PREFIX, (request, response, next) => {
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
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
    if (!acceptsBearer(request.method, `${request.baseUrl}${request.path}`)) {
      sendError(response, 401, "UNAUTHENTICATED", "Unauthenticated");
      return;
    }
    const secret = BEARER_AUTHORIZATION.exec(authorization)?.[1];
    if (secret === undefined) {
      response.set("WWW-Authenticate", "Bearer");
      sendError(response, 401, "UNAUTHENTICATED", "Unauthenticated");
      return;
    }
    response.locals[BEARER_SECRET_LOCAL] = secret;
    next();
  });

  app.use((request, response, next) => {
    // A Bearer request carries no session, so there is nothing to forge.
    if (
      response.locals[BEARER_SECRET_LOCAL] !== undefined ||
      !request.headers.cookie ||
      !["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
    ) {
      next();
      return;
    }

    if (request.headers.origin !== (publicOrigin ?? requestOrigin(request))) {
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
      response.locals[BEARER_SECRET_LOCAL] !== undefined ||
      ONBOARDING_PATHS.has(request.path) ||
      // Answers a missing, stale or onboarding session with a redirect itself.
      request.path === AUTHORIZE_PATH ||
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
    let state: Readiness = "unavailable";

    try {
      state = database.readiness
        ? await database.readiness()
        : (await database.isReady())
          ? "ready"
          : "unavailable";
    } catch {
      state = "unavailable";
    }

    if (state === "migrations_pending") {
      response
        .status(503)
        .json({ status: "unavailable", code: "MIGRATIONS_PENDING" });
      return;
    }
    if (state !== "ready") {
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

  // Swagger UI over the document above: public like /openapi.json and outside
  // API_PREFIX, so the Authorization guard never sees these requests.
  app.use(createDocsRouter());

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

  app.use(API_PREFIX, api);

  // Private service-to-service routes: outside API_PREFIX, undocumented, not
  // proxied by the public nginx and never reachable with a user session or a
  // user API token (only the service credential passes the guard).
  // One guard (one limiter) for every private route: a client cannot spread
  // its wrong guesses across them.
  const internalGuard = createServiceCredentialGuard(
    internalServiceSecret,
    internalAuthLimiter,
  );

  app.post(
    INTROSPECTION_PATH,
    internalGuard,
    createIntrospectionHandler(
      apiTokenIntrospection ??
        (prisma && createApiTokenIntrospectionService(prisma)),
    ),
  );

  app.post(
    SESSION_INTROSPECTION_PATH,
    internalGuard,
    createSessionIntrospectionHandler(
      sessionIntrospection ??
        (prisma && createSessionIntrospectionService(prisma)),
    ),
  );

  app.post(EXCHANGE_PATH, internalGuard, createExchangeHandler(ssoService));

  app.post(REVOKE_PATH, internalGuard, createRevokeHandler(ssoService));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
