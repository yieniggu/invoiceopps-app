import type { PrismaClient } from "./generated/prisma/client.js";
import { normalizeRut } from "./identity.js";
import { hashPassword } from "./auth.js";

/** Internal seed/test provisioner. It is intentionally never registered as HTTP. */
export async function provisionInternalUser(
  prisma: PrismaClient,
  input: { name: string; rut: string; password: string },
) {
  return prisma.user.create({
    data: {
      name: input.name.trim(),
      rut: normalizeRut(input.rut),
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, name: true, rut: true },
  });
}
