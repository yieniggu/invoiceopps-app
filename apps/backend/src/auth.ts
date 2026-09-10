import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import {
  OrganizationRole,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { normalizeRut } from "./identity.js";

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(PASSWORD_KEY_LENGTH).toString("base64")}`;

export type AuthMode = "open" | "allowlist";

export interface AuthUser {
  id: string;
  name: string;
  rut: string;
}

export interface AuthService {
  signUp(input: {
    name: string;
    rut: string;
    password: string;
  }): Promise<AuthUser>;
  login(input: { rut: string; password: string }): Promise<{
    sessionToken: string;
    user: AuthUser;
  }>;
}

export interface AuthServiceOptions {
  verifyPassword?: (password: string, passwordHash: string) => Promise<boolean>;
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

function parseSignUp(input: {
  name: unknown;
  rut: unknown;
  password: unknown;
}) {
  if (typeof input.name !== "string" || !input.name.trim()) {
    throw new AuthError(400, "Invalid signup request");
  }

  if (typeof input.rut !== "string" || typeof input.password !== "string") {
    throw new AuthError(400, "Invalid signup request");
  }

  if (input.password.length < 12) {
    throw new AuthError(400, "Invalid signup request");
  }

  try {
    return {
      name: input.name.trim(),
      password: input.password,
      rut: normalizeRut(input.rut),
    };
  } catch {
    throw new AuthError(400, "Invalid signup request");
  }
}

function parseLogin(input: { rut: unknown; password: unknown }) {
  if (typeof input.rut !== "string" || typeof input.password !== "string") {
    throw new AuthError(401, "Invalid credentials");
  }

  try {
    return { password: input.password, rut: normalizeRut(input.rut) };
  } catch {
    throw new AuthError(401, "Invalid credentials");
  }
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(
    password,
    salt,
    PASSWORD_KEY_LENGTH,
  )) as Buffer;

  return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

async function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, encodedSalt, encodedHash] = passwordHash.split("$");

  if (algorithm !== "scrypt" || !encodedSalt || !encodedHash) {
    return false;
  }

  const salt = Buffer.from(encodedSalt, "base64");
  const expectedHash = Buffer.from(encodedHash, "base64");

  if (salt.length !== 16 || expectedHash.length !== PASSWORD_KEY_LENGTH) {
    return false;
  }

  const actualHash = (await scryptAsync(
    password,
    salt,
    expectedHash.length,
  )) as Buffer;

  return (
    expectedHash.length === actualHash.length &&
    timingSafeEqual(expectedHash, actualHash)
  );
}

export function authModeFromEnvironment(
  value = process.env.AUTH_MODE,
): AuthMode {
  if (value === undefined || value === "open") {
    return "open";
  }

  if (value === "allowlist") {
    return value;
  }

  throw new Error("AUTH_MODE must be open or allowlist");
}

export function createAuthService(
  prisma: PrismaClient,
  authMode = authModeFromEnvironment(),
  {
    verifyPassword: passwordVerifier = verifyPassword,
  }: AuthServiceOptions = {},
): AuthService {
  return {
    async signUp(input) {
      const signup = parseSignUp(input);
      const passwordHash = await hashPassword(signup.password);

      try {
        return await prisma.$transaction(async (transaction) => {
          const authorizedOrganizations =
            authMode === "allowlist"
              ? await transaction.authorizedUserOrganization.findMany({
                  where: { rut: signup.rut },
                  select: { organizationId: true },
                })
              : [];

          if (
            authMode === "allowlist" &&
            authorizedOrganizations.length === 0
          ) {
            throw new AuthError(403, "Signup is not authorized");
          }

          return transaction.user.create({
            data: {
              name: signup.name,
              rut: signup.rut,
              passwordHash,
              memberships: {
                create: authorizedOrganizations.map(({ organizationId }) => ({
                  organizationId,
                  role: OrganizationRole.STUDENT,
                })),
              },
            },
            select: { id: true, name: true, rut: true },
          });
        });
      } catch (error) {
        if (error instanceof AuthError) {
          throw error;
        }

        if ((error as { code?: unknown }).code === "P2002") {
          throw new AuthError(409, "Account cannot be created");
        }

        throw error;
      }
    },
    async login(input) {
      const login = parseLogin(input);
      const user = await prisma.user.findUnique({
        where: { rut: login.rut },
        select: { id: true, name: true, rut: true, passwordHash: true },
      });

      const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const passwordMatches = await passwordVerifier(
        login.password,
        passwordHash,
      );

      if (!user?.passwordHash || !passwordMatches) {
        throw new AuthError(401, "Invalid credentials");
      }

      const sessionToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256")
        .update(sessionToken)
        .digest("base64");
      await prisma.session.create({
        data: {
          tokenHash,
          userId: user.id,
          expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
        },
      });

      return {
        sessionToken,
        user: { id: user.id, name: user.name, rut: user.rut },
      };
    },
  };
}
