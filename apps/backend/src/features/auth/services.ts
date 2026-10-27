import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  type Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { formatRut, parseRut } from "../../rut.js";
import { capabilitiesFromGroup } from "../groups/invoice-permissions.js";
import { isAcceptablePassword } from "./password-policy.js";

const scryptAsync = promisify(scrypt);
const PASSWORD_KEY_LENGTH = 64;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const INVALID_CREDENTIALS = "Invalid credentials";
const UNAUTHENTICATED_MESSAGE = "Unauthenticated";
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
  /** Group-level capabilities; absent for services that do not derive them. */
  contexts?: AuthContext[];
}

export interface AuthContext {
  organizationId: string;
  organizationName: string;
  groupId: string;
  groupName: string;
  capabilities: {
    readInvoices: boolean;
    createInvoices: boolean;
    deleteOwnInvoices: boolean;
    deleteOthersInvoices: boolean;
  };
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
  /** Resolves with the rotated session; fakes may resolve with nothing. */
  changePassword?(
    sessionToken: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ sessionToken: string } | void>;
}

export interface AuthServiceOptions {
  verifyPassword?: (password: string, passwordHash: string) => Promise<boolean>;
  now?: () => Date;
}

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
    /** Overrides the default status-derived public error code. */
    readonly code?: "PASSWORD_REUSE",
  ) {
    super(message);
  }
}

function parseLogin(input: { rut: unknown; password: unknown }) {
  if (typeof input.rut !== "string" || typeof input.password !== "string") {
    throw new AuthError(401, INVALID_CREDENTIALS);
  }

  try {
    return { password: input.password, rut: parseRut(input.rut) };
  } catch {
    throw new AuthError(401, INVALID_CREDENTIALS);
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

/**
 * A temporary credential is only usable until it expires: while a password
 * change is pending, a missing or past expiry means the credential is dead.
 */
export function temporaryPasswordExpired(
  user: {
    mustChangePassword: boolean;
    temporaryPasswordExpiresAt: Date | null;
  },
  at: Date,
) {
  return (
    user.mustChangePassword &&
    (!user.temporaryPasswordExpiresAt || user.temporaryPasswordExpiresAt <= at)
  );
}

export function createAuthService(
  prisma: PrismaClient,
  {
    verifyPassword: passwordVerifier = verifyPassword,
    now = () => new Date(),
  }: AuthServiceOptions = {},
): AuthService {
  // Serializes every credential change and session creation per user. Row
  // locks need no schema change; the lock holder re-reads the credential.
  async function lockUser(
    transaction: Prisma.TransactionClient,
    userId: string,
  ) {
    await transaction.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  }

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
            groupMemberships: {
              where: { group: { organization: { enabled: true } } },
              select: {
                organizationId: true,
                group: {
                  select: {
                    id: true,
                    name: true,
                    readInvoices: true,
                    createInvoices: true,
                    deleteOwnInvoices: true,
                    deleteOthersInvoices: true,
                    organization: { select: { id: true, name: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!session || session.expiresAt <= now()) {
      throw new AuthError(401, UNAUTHENTICATED_MESSAGE);
    }

    const { groupMemberships, ...user } = session.user;
    // A context needs an enabled organization (filtered in the query) plus
    // both the organization and the group membership; capabilities are the
    // group's own flags, with no per-user override.
    const organizationIds = new Set(
      user.memberships.map((membership) => membership.organization.id),
    );
    const contexts = groupMemberships
      .filter(({ organizationId }) => organizationIds.has(organizationId))
      .map(({ group }) => ({
        organizationId: group.organization.id,
        organizationName: group.organization.name,
        groupId: group.id,
        groupName: group.name,
        capabilities: capabilitiesFromGroup(group),
      }))
      .sort(
        (a, b) =>
          a.organizationName.localeCompare(b.organizationName) ||
          a.organizationId.localeCompare(b.organizationId) ||
          a.groupName.localeCompare(b.groupName) ||
          a.groupId.localeCompare(b.groupId),
      );

    return {
      ...user,
      rut: formatRut(user.rut),
      isPlatformAdministrator: user.platformAdministrator !== null,
      contexts,
    };
  }

  async function logout(sessionToken: string): Promise<void> {
    const result = await prisma.session.deleteMany({
      where: {
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: { gt: now() },
      },
    });

    if (result.count !== 1) {
      throw new AuthError(401, UNAUTHENTICATED_MESSAGE);
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
        temporaryPasswordExpired(user, now())
      ) {
        throw new AuthError(401, INVALID_CREDENTIALS);
      }

      const sessionToken = randomBytes(32).toString("base64url");
      // The password was verified outside the transaction (scrypt is slow);
      // under the user lock the credential is re-read and must be unchanged.
      await prisma.$transaction(async (transaction) => {
        await lockUser(transaction, user.id);
        const current = await transaction.user.findUnique({
          where: { id: user.id },
          select: {
            passwordHash: true,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: true,
          },
        });
        const at = now();
        if (
          !current ||
          current.passwordHash !== user.passwordHash ||
          temporaryPasswordExpired(current, at)
        ) {
          throw new AuthError(401, INVALID_CREDENTIALS);
        }

        const expiresAt = new Date(at.getTime() + SESSION_LIFETIME_MS);
        await transaction.session.create({
          data: {
            tokenHash: hashSessionToken(sessionToken),
            userId: user.id,
            expiresAt:
              current.mustChangePassword && current.temporaryPasswordExpiresAt
                ? new Date(
                    Math.min(
                      expiresAt.getTime(),
                      current.temporaryPasswordExpiresAt.getTime(),
                    ),
                  )
                : expiresAt,
          },
        });
      });

      return {
        sessionToken,
        user: { id: user.id, name: user.name, rut: formatRut(user.rut) },
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
        !isAcceptablePassword(input.newPassword)
      ) {
        throw new AuthError(400, "Invalid password change");
      }
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashSessionToken(sessionToken) },
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
        session.expiresAt <= now() ||
        !session.user.passwordHash ||
        temporaryPasswordExpired(session.user, now())
      ) {
        throw new AuthError(401, UNAUTHENTICATED_MESSAGE);
      }
      const currentHash = session.user.passwordHash;
      if (!(await passwordVerifier(input.currentPassword, currentHash))) {
        throw new AuthError(401, INVALID_CREDENTIALS);
      }
      if (await passwordVerifier(input.newPassword, currentHash)) {
        throw new AuthError(
          400,
          "The new password must differ from the current one.",
          "PASSWORD_REUSE",
        );
      }
      const newHash = await hashPassword(input.newPassword);
      const newSessionToken = randomBytes(32).toString("base64url");
      const tokenHash = hashSessionToken(sessionToken);

      await prisma.$transaction(async (transaction) => {
        await lockUser(transaction, session.userId);
        // Re-verify under the lock: a concurrent change or logout invalidates
        // this attempt instead of reviving the old credential or session.
        const user = await transaction.user.findUnique({
          where: { id: session.userId },
          select: {
            passwordHash: true,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: true,
          },
        });
        const activeSession = await transaction.session.findUnique({
          where: { tokenHash },
          select: { expiresAt: true },
        });
        const at = now();
        if (
          !user ||
          user.passwordHash !== currentHash ||
          temporaryPasswordExpired(user, at) ||
          !activeSession ||
          activeSession.expiresAt <= at
        ) {
          throw new AuthError(401, UNAUTHENTICATED_MESSAGE);
        }

        await transaction.user.update({
          where: { id: session.userId },
          data: {
            passwordHash: newHash,
            mustChangePassword: false,
            temporaryPasswordExpiresAt: null,
          },
        });
        await transaction.session.deleteMany({
          where: { userId: session.userId },
        });
        await transaction.session.create({
          data: {
            tokenHash: hashSessionToken(newSessionToken),
            userId: session.userId,
            expiresAt: new Date(at.getTime() + SESSION_LIFETIME_MS),
          },
        });
        await transaction.apiToken.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: at },
        });
        await transaction.platformAdministrativeAuditEvent.create({
          data: {
            type: PlatformAdministrativeAuditEventType.PASSWORD_CHANGED,
            actorUserId: session.userId,
            targetUserId: session.userId,
          },
        });
      });

      return { sessionToken: newSessionToken };
    },
  };
}
