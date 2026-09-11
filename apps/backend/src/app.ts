import express, { type ErrorRequestHandler } from "express";

import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { AuthError, type AuthService } from "./auth.js";
import type { DatabaseReadiness } from "./database.js";

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

function profileResponse(
  profile: Awaited<ReturnType<AuthService["getProfile"]>>,
) {
  return {
    profile: {
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
}

export function createApp(
  database: DatabaseReadiness,
  auth?: AuthService,
  { authRateLimiter = createAuthRateLimiter() }: AppOptions = {},
) {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

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
