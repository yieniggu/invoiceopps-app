import request from "./support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createAuthService, type AuthService } from "../src/auth.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import { createUserService } from "../src/features/users/services.js";

const ORGANIZATION_ID = "organization-1";
const ACTOR_ID = "platform-admin-1";
const COOKIE = "invoiceops_session=platform-session";

const profile = {
  id: ACTOR_ID,
  name: "Platform Admin",
  rut: "123456785",
  email: null,
  username: null,
  isPlatformAdministrator: true,
  memberships: [],
};

function createAuthStub(): AuthService {
  return {
    async login() {
      throw new Error("not used");
    },
    async logout() {},
    async getProfile() {
      return profile;
    },
    async updateProfile() {
      return profile;
    },
  };
}

function createFakePrisma() {
  const created: Array<{ data: { rut: string } }> = [];
  const transaction = {
    organizationMembership: {
      findUnique: vi.fn(async () => ({ role: "ADMIN" })),
    },
    user: {
      create: vi.fn(async (args: { data: { name: string; rut: string } }) => {
        created.push(args);
        return { id: "user-2", name: args.data.name, rut: args.data.rut };
      }),
    },
    platformAdministrativeAuditEvent: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    organizationMembership: transaction.organizationMembership,
    $transaction: async (operation: (tx: typeof transaction) => unknown) =>
      operation(transaction),
  } as unknown as PrismaClient;

  return { prisma, transaction, created };
}

function provision(app: ReturnType<typeof createApp>, rut: string) {
  return request(app)
    .post(`/api/v1/organizations/${ORGANIZATION_ID}/users`)
    .set("Host", "127.0.0.1")
    .set("Origin", "http://127.0.0.1")
    .set("Cookie", COOKIE)
    .send({ name: "Student", rut, role: "USER" });
}

describe("RV-081 POST /organizations/{organizationId}/users RUT contract", () => {
  it.each([
    ["wrong verification digit", "12345678-4"],
    ["leading zero body", "01234567-4"],
    ["all zeros", "00000000-0"],
    ["dotted leading zero", "0.123.456-7"],
  ])("answers 400 and writes nothing for %s", async (_label, rut) => {
    const { prisma, transaction } = createFakePrisma();
    const app = createApp({ isReady: async () => true }, createAuthStub(), {
      users: createUserService(prisma),
    });

    const response = await provision(app, rut);

    expect(response.status).toBe(400);
    expect(transaction.user.create).not.toHaveBeenCalled();
  });

  it("stores and answers with the canonical RUT", async () => {
    const { prisma, created } = createFakePrisma();
    const app = createApp({ isReady: async () => true }, createAuthStub(), {
      users: createUserService(prisma),
    });

    const response = await provision(app, "19.034.790-7");

    expect(response.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0].data.rut).toBe("190347907");
    expect(response.body.user).toMatchObject({
      id: "user-2",
      rut: "190347907",
      mustChangePassword: true,
    });
    expect(response.body.membership).toEqual({
      userId: "user-2",
      organizationId: ORGANIZATION_ID,
      role: "USER",
    });
    expect(typeof response.body.temporaryPassword).toBe("string");
  });
});

describe("RV-081 login with a malformed RUT", () => {
  it("answers 401 with exactly the same body as a wrong password", async () => {
    const findUnique = vi.fn(async () => null);
    const auth = createAuthService(
      { user: { findUnique } } as unknown as PrismaClient,
      {
        verifyPassword: async () => false,
      },
    );
    const app = createApp({ isReady: async () => true }, auth);
    const login = (rut: string) =>
      request(app)
        .post("/api/v1/auth/login")
        .send({ rut, password: "correct-horse-battery-staple" });

    const wrongPassword = await login("12.345.678-5");
    const malformed = await login("01234567-4");
    const badDigit = await login("12345678-4");

    expect(wrongPassword.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(badDigit.status).toBe(401);
    expect(malformed.body).toEqual(wrongPassword.body);
    expect(badDigit.body).toEqual(wrongPassword.body);
    expect(malformed.text).toBe(wrongPassword.text);
  });
});
