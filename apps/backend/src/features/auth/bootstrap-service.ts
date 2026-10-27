import {
  PlatformAdministrativeAuditEventType,
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { hashPassword, temporaryPasswordExpired } from "./services.js";
import { runSerializable } from "../../platform-administrator.js";
import { parseRut } from "../../rut.js";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isAcceptablePassword,
} from "./password-policy.js";

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 120;
const MAX_UNIQUE_RETRIES = 3;

/** Input rejected before any mutation. Messages never contain the password. */
export class BootstrapInputError extends Error {}

/** Valid input refused because of the current database state. */
export class BootstrapRejectedError extends Error {}

export interface BootstrapInput {
  name: string;
  rut: string;
  password: string;
}

export type BootstrapOutcome = "created" | "unchanged" | "designated";

export interface BootstrapResult {
  outcome: BootstrapOutcome;
  userId: string;
}

export interface BootstrapService {
  bootstrap(input: BootstrapInput): Promise<BootstrapResult>;
  designateExisting(rut: string): Promise<BootstrapResult>;
}

export interface BootstrapServiceOptions {
  now?: () => Date;
  /**
   * TEST ONLY. Runs inside the transaction right after the user is created so
   * tests can force an overlap. The CLI never passes it.
   */
  afterUserCreated?: () => Promise<void> | void;
  /**
   * TEST ONLY. Runs inside the transaction once the designation is written so
   * tests can force an overlap. The CLI never passes it.
   */
  afterDesignated?: () => Promise<void> | void;
}

export function parseBootstrapInput(input: BootstrapInput): BootstrapInput {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new BootstrapInputError("Invalid name");
  }
  let rut: string;
  try {
    rut = parseRut(input.rut);
  } catch {
    throw new BootstrapInputError("Invalid RUT");
  }
  if (!isAcceptablePassword(input.password)) {
    throw new BootstrapInputError(
      `The temporary password must have between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  return { name, rut, password: input.password };
}

function parseExistingRut(rut: string) {
  try {
    return parseRut(rut);
  } catch {
    throw new BootstrapInputError("Invalid RUT");
  }
}

function isUniqueViolation(error: unknown) {
  return (error as { code?: unknown }).code === "P2002";
}

export function createBootstrapService(
  prisma: PrismaClient,
  {
    now = () => new Date(),
    afterUserCreated,
    afterDesignated,
  }: BootstrapServiceOptions = {},
): BootstrapService {
  async function inSerializableTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // A losing concurrent run surfaces either as a serialization failure
    // (retried by runSerializable) or as a unique violation; both re-evaluate
    // from the committed state, where the winner is visible.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runSerializable(
          () =>
            prisma.$transaction(operation, {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            }),
          () =>
            new BootstrapRejectedError(
              "Bootstrap conflicted with a concurrent run; retry",
            ),
        );
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= MAX_UNIQUE_RETRIES - 1) {
          throw error;
        }
      }
    }
  }

  async function currentDesignation(
    transaction: Prisma.TransactionClient,
    rut: string,
  ): Promise<BootstrapResult | undefined> {
    const administrator = await transaction.platformAdministrator.findUnique({
      where: { id: 1 },
      select: { userId: true, user: { select: { rut: true } } },
    });
    if (!administrator) return undefined;
    if (administrator.user.rut === rut) {
      return { outcome: "unchanged", userId: administrator.userId };
    }
    throw new BootstrapRejectedError(
      "A different platform administrator already exists; authority is not transferred",
    );
  }

  async function designate(
    transaction: Prisma.TransactionClient,
    userId: string,
  ) {
    await transaction.platformAdministrator.create({
      data: { id: 1, userId },
    });
    await transaction.platformAdministrativeAuditEvent.create({
      data: {
        type: PlatformAdministrativeAuditEventType.PLATFORM_ADMINISTRATOR_BOOTSTRAPPED,
        actorUserId: userId,
        targetUserId: userId,
      },
    });
    await afterDesignated?.();
  }

  return {
    async bootstrap(rawInput) {
      const input = parseBootstrapInput(rawInput);
      const passwordHash = await hashPassword(input.password);

      return inSerializableTransaction(async (transaction) => {
        const existing = await currentDesignation(transaction, input.rut);
        if (existing) return existing;

        const duplicate = await transaction.user.findUnique({
          where: { rut: input.rut },
          select: { id: true },
        });
        if (duplicate) {
          throw new BootstrapRejectedError(
            "The RUT already exists; use --existing-user to designate it",
          );
        }

        const user = await transaction.user.create({
          data: {
            name: input.name,
            rut: input.rut,
            passwordHash,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: new Date(
              now().getTime() + TEMPORARY_PASSWORD_LIFETIME_MS,
            ),
          },
          select: { id: true },
        });
        await afterUserCreated?.();
        await designate(transaction, user.id);
        return { outcome: "created", userId: user.id };
      });
    },
    async designateExisting(rawRut) {
      const rut = parseExistingRut(rawRut);

      return inSerializableTransaction(async (transaction) => {
        const existing = await currentDesignation(transaction, rut);
        if (existing) return existing;

        const user = await transaction.user.findUnique({
          where: { rut },
          select: {
            id: true,
            passwordHash: true,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: true,
          },
        });
        if (!user) {
          throw new BootstrapRejectedError("No user exists with that RUT");
        }
        if (!user.passwordHash) {
          throw new BootstrapRejectedError("The user has no usable credential");
        }
        // A pending temporary password that already expired (or never had an
        // expiry) cannot log in, so designating it would create an unusable
        // administrator.
        if (temporaryPasswordExpired(user, now())) {
          throw new BootstrapRejectedError(
            "The user's temporary password expired; the user has no usable credential",
          );
        }
        await designate(transaction, user.id);
        return { outcome: "designated", userId: user.id };
      });
    },
  };
}
