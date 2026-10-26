import type { PrismaClient } from "./generated/prisma/client.js";
import { parseRut } from "./rut.js";
import { hashPassword } from "./auth.js";

/** Internal seed/test provisioner. It is intentionally never registered as HTTP. */
export async function provisionInternalUser(
  prisma: PrismaClient,
  input: { name: string; rut: string; password: string },
) {
  return prisma.user.create({
    data: {
      name: input.name.trim(),
      rut: parseRut(input.rut),
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, name: true, rut: true },
  });
}
