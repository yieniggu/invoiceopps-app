import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { normalizeRut } from "./identity.js";

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(PASSWORD_KEY_LENGTH).toString("base64")}`;

export interface AuthUser {
  id: string;
  name: string;
  rut: string;
}

export interface AuthProfile extends AuthUser {
  email: string | null;
  username: string | null;
  mustChangePassword?: boolean;
  isPlatformAdministrator: boolean;
  memberships: Array<{
    organization: { id: string; name: string; slug: string };
    role: OrganizationRole;
  }>;
}

export interface AuthService {
  login(input: { rut: string; password: string }): Promise<{
    sessionToken: string;
    user: AuthUser;
  }>;
  logout(sessionToken: string): Promise<void>;
  getProfile(sessionToken: string): Promise<AuthProfile>;
  updateProfile(
    sessionToken: string,
    input: { email?: string | null; username?: string | null },
  ): Promise<AuthProfile>;
  changePassword?(
    sessionToken: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void>;
}

export interface AuthServiceOptions {
  verifyPassword?: (password: string, passwordHash: string) => Promise<boolean>;
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
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

function hashSessionToken(sessionToken: string) {
  return createHash("sha256").update(sessionToken).digest("base64");
}

export async function hashPassword(password: string) {
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

export function createAuthService(
  prisma: PrismaClient,
  {
    verifyPassword: passwordVerifier = verifyPassword,
  }: AuthServiceOptions = {},
): AuthService {
  async function getProfile(sessionToken: string): Promise<AuthProfile> {
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(sessionToken) },
      select: {
        expiresAt: true,
        user: {
          select: {
            id: true,
            name: true,
            rut: true,
            email: true,
            username: true,
            mustChangePassword: true,
            platformAdministrator: { select: { id: true } },
            memberships: {
              orderBy: [
                { organization: { slug: "asc" } },
                { organizationId: "asc" },
              ],
              select: {
                role: true,
                organization: {
                  select: { id: true, name: true, slug: true },
                },
              },
            },
          },
        },
      },
    });

    if (!session || session.expiresAt <= new Date()) {
      throw new AuthError(401, "Unauthorized");
    }

    return {
      ...session.user,
      isPlatformAdministrator: session.user.platformAdministrator !== null,
    };
  }

  async function logout(sessionToken: string): Promise<void> {
    const result = await prisma.session.deleteMany({
      where: {
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: { gt: new Date() },
      },
    });

    if (result.count !== 1) {
      throw new AuthError(401, "Unauthorized");
    }
  }

  return {
    async login(input) {
      const login = parseLogin(input);
      const user = await prisma.user.findUnique({
        where: { rut: login.rut },
        select: {
          id: true,
          name: true,
          rut: true,
          passwordHash: true,
          mustChangePassword: true,
          temporaryPasswordExpiresAt: true,
        },
      });

      const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
      const passwordMatches = await passwordVerifier(
        login.password,
        passwordHash,
      );

      if (
        !user?.passwordHash ||
        !passwordMatches ||
        (user.mustChangePassword &&
          (!user.temporaryPasswordExpiresAt ||
            user.temporaryPasswordExpiresAt <= new Date()))
      ) {
        throw new AuthError(401, "Invalid credentials");
      }

      const sessionToken = randomBytes(32).toString("base64url");
      await prisma.session.create({
        data: {
          tokenHash: hashSessionToken(sessionToken),
          userId: user.id,
          expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
        },
      });

      return {
        sessionToken,
        user: { id: user.id, name: user.name, rut: user.rut },
      };
    },
    logout,
    getProfile,
    async updateProfile(sessionToken, input) {
      const profile = await getProfile(sessionToken);
      const user = await prisma.user.update({
        where: { id: profile.id },
        data: input,
        select: { email: true, username: true },
      });

      return { ...profile, ...user };
    },
    async changePassword(sessionToken, input) {
      if (
        typeof input.currentPassword !== "string" ||
        typeof input.newPassword !== "string" ||
        input.newPassword.length < 12
      ) {
        throw new AuthError(400, "Invalid password change");
      }
      const tokenHash = hashSessionToken(sessionToken);
      const session = await prisma.session.findUnique({
        where: { tokenHash },
        select: {
          userId: true,
          expiresAt: true,
          user: {
            select: {
              passwordHash: true,
              mustChangePassword: true,
              temporaryPasswordExpiresAt: true,
            },
          },
        },
      });
      if (
        !session ||
        session.expiresAt <= new Date() ||
        !session.user.passwordHash ||
        (session.user.mustChangePassword &&
          (!session.user.temporaryPasswordExpiresAt ||
            session.user.temporaryPasswordExpiresAt <= new Date()))
      ) {
        throw new AuthError(401, "Unauthorized");
      }
      if (
        !(await passwordVerifier(
          input.currentPassword,
          session.user.passwordHash,
        ))
      ) {
        throw new AuthError(401, "Invalid credentials");
      }
      const passwordHash = await hashPassword(input.newPassword);
      await prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: { id: session.userId },
          data: {
            passwordHash,
            mustChangePassword: false,
            temporaryPasswordExpiresAt: null,
          },
        });
        await transaction.session.deleteMany({
          where: { userId: session.userId, tokenHash: { not: tokenHash } },
        });
        await transaction.platformAdministrativeAuditEvent.create({
          data: {
            type: PlatformAdministrativeAuditEventType.PASSWORD_CHANGED,
            actorUserId: session.userId,
            targetUserId: session.userId,
          },
        });
      });
    },
  };
}
