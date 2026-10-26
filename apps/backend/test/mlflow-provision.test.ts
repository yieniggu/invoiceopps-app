import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { AuthError, type AuthService } from "../src/auth.js";
import type { MlflowProvisionService } from "../src/mlflow-provision.js";

function createProvisionTestApp() {
  const getProfile = vi
    .fn<AuthService["getProfile"]>()
    .mockRejectedValue(new AuthError(401, "Unauthorized"));
  const auth: AuthService = {
    async login() {
      throw new Error("login must not be called");
    },
    async logout() {
      throw new Error("logout must not be called");
    },
    getProfile,
    async updateProfile() {
      throw new Error("updateProfile must not be called");
    },
  };

  return {
    app: createApp({ isReady: async () => true }, auth),
    getProfile,
  };
}

describe("MLFLOW07 provisioning authentication HTTP contract", () => {
  it("returns 401 for an absent session without looking up a profile", async () => {
    const { app, getProfile } = createProvisionTestApp();

    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .send({ organizationSlug: "data-academy", dryRun: true });

    expect.soft(response.status).toBe(401);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid session after passing its token to getProfile", async () => {
    const { app, getProfile } = createProvisionTestApp();
    const sessionToken = "synthetic-invalid-session";

    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", `invoiceops_session=${sessionToken}`)
      .send({ organizationSlug: "data-academy", dryRun: true });

    expect.soft(response.status).toBe(401);
    expect.soft(getProfile).toHaveBeenCalledTimes(1);
    expect(getProfile).toHaveBeenCalledWith(sessionToken);
  });

  it("returns 401 for an expired session after passing its token to getProfile", async () => {
    const { app, getProfile } = createProvisionTestApp();
    const sessionToken = "synthetic-expired-session";

    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", `invoiceops_session=${sessionToken}`)
      .send({ organizationSlug: "data-academy", dryRun: true });

    expect.soft(response.status).toBe(401);
    expect.soft(getProfile).toHaveBeenCalledTimes(1);
    expect(getProfile).toHaveBeenCalledWith(sessionToken);
  });

  it("preserves the safe CSRF 403 for a foreign origin before profile lookup", async () => {
    const { app, getProfile } = createProvisionTestApp();

    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "https://untrusted.example.test")
      .set("Cookie", "invoiceops_session=synthetic-csrf-session")
      .send({ organizationSlug: "data-academy", dryRun: true });

    expect.soft(response.status).toBe(403);
    expect.soft(response.body).toEqual({
      status: "error",
      message: "Forbidden",
    });
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe("MLFLOW07 platform authorization and strict HTTP input", () => {
  function authorizedApp(platform: boolean) {
    const auth: AuthService = {
      login: vi.fn(),
      logout: vi.fn(),
      updateProfile: vi.fn(),
      getProfile: vi.fn(async () => ({
        id: "synthetic-actor",
        name: "Synthetic",
        rut: "123456785",
        email: null,
        username: null,
        isPlatformAdministrator: platform,
        memberships: [
          {
            organization: {
              id: "synthetic-org",
              name: "Synthetic",
              slug: "data-academy",
            },
            role: "ADMIN" as const,
          },
        ],
      })),
    };
    const provision = vi.fn<MlflowProvisionService["provision"]>();
    const app = createApp({ isReady: async () => true }, auth, {
      mlflowProvision: { provision },
    });
    return { app, provision };
  }

  it("does not treat organization ADMIN as platform administrator", async () => {
    const { app, provision } = authorizedApp(false);
    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=synthetic")
      .send({ organizationSlug: "data-academy", dryRun: true });
    expect(response.status).toBe(403);
    expect(provision).not.toHaveBeenCalled();
  });

  it.each([
    { organizationSlug: "data-academy" },
    { organizationSlug: "data-academy", dryRun: "false" },
    { organizationSlug: "data-academy", dryRun: true, username: "attacker" },
    { organizationSlug: "../other", dryRun: true },
    { organizationSlug: "Data-Academy", dryRun: true },
    { organizationSlug: "workspaces", dryRun: true },
    { organizationSlug: "api", dryRun: true },
    { organizationSlug: "ajax-api", dryRun: true },
    { organizationSlug: "static-files", dryRun: true },
  ])(
    "rejects invalid input before privileged service invocation: %j",
    async (body) => {
      const { app, provision } = authorizedApp(true);
      const response = await request(app)
        .post("/admin/mlflow/provision")
        .set("Host", "127.0.0.1")
        .set("Origin", "http://127.0.0.1")
        .set("Cookie", "invoiceops_session=synthetic")
        .send(body);
      expect(response.status).toBe(400);
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it("passes only authenticated actor and exact input to provisioning", async () => {
    const { app, provision } = authorizedApp(true);
    provision.mockResolvedValue({
      httpStatus: 200,
      body: {
        status: "ok",
        correlationId: "synthetic-correlation",
        dryRun: true,
        reused: 0,
        unknownEffects: 0,
        planned: {
          workspace: 1,
          user: 0,
          experiment: 0,
          model: 0,
          role: 0,
          revoke: 0,
          grant: 0,
          assign: 0,
          unassign: 0,
        },
        confirmed: {
          workspace: 0,
          user: 0,
          experiment: 0,
          model: 0,
          role: 0,
          revoke: 0,
          grant: 0,
          assign: 0,
          unassign: 0,
        },
      },
    });
    const response = await request(app)
      .post("/admin/mlflow/provision")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=synthetic")
      .send({ organizationSlug: "data-academy", dryRun: true });
    expect(response.status).toBe(200);
    expect(provision).toHaveBeenCalledWith("synthetic-actor", {
      organizationSlug: "data-academy",
      dryRun: true,
    });
  });

  it.each([
    "/admin/mlflow/provision",
    "/admin/mlflow/provision/",
    "/ADMIN/MLFLOW/PROVISION",
    "/Admin/Mlflow/Provision/",
  ])(
    "protects parser and dependency failures for accepted alias %s",
    async (path) => {
      const { app, provision } = authorizedApp(true);
      const logger = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const malformed = await request(app)
          .post(path)
          .set("Content-Type", "application/json")
          .send('{"raw-secret-marker":');
        expect.soft(malformed.status).toBe(400);
        expect.soft(malformed.body).toEqual({ status: "error", code: "INPUT" });
        const oversized = await request(app)
          .post(path)
          .set("Content-Type", "application/json")
          .send(JSON.stringify({ marker: "raw-secret-marker".repeat(2000) }));
        expect.soft(oversized.status).toBe(400);
        expect.soft(oversized.body).toEqual({ status: "error", code: "INPUT" });
        expect(provision).not.toHaveBeenCalled();
        provision.mockRejectedValue(
          new Error("raw-secret-marker-provider-url"),
        );
        const unavailable = await request(app)
          .post(path)
          .set("Host", "127.0.0.1")
          .set("Origin", "http://127.0.0.1")
          .set("Cookie", "invoiceops_session=synthetic")
          .send({ organizationSlug: "data-academy", dryRun: false });
        expect.soft(unavailable.status).toBe(503);
        expect
          .soft(unavailable.body)
          .toEqual({ status: "error", code: "DEPENDENCY" });
        expect(provision).toHaveBeenCalledTimes(1);
        expect(
          JSON.stringify([
            malformed.body,
            oversized.body,
            unavailable.body,
            logger.mock.calls,
          ]),
        ).not.toContain("raw-secret-marker");
        expect(logger).not.toHaveBeenCalled();
      } finally {
        logger.mockRestore();
      }
    },
  );

  it.each([
    "/admin/mlflow/provision/",
    "/ADMIN/MLFLOW/PROVISION",
    "/Admin/Mlflow/Provision/",
  ])("preserves authorization before service I/O for %s", async (path) => {
    const absent = createProvisionTestApp();
    expect((await request(absent.app).post(path).send({})).status).toBe(401);
    expect(absent.getProfile).not.toHaveBeenCalled();
    const { app, provision } = authorizedApp(false);
    expect(
      (
        await request(app)
          .post(path)
          .set("Host", "127.0.0.1")
          .set("Origin", "http://127.0.0.1")
          .set("Cookie", "invoiceops_session=synthetic")
          .send({})
      ).status,
    ).toBe(403);
    expect(provision).not.toHaveBeenCalled();
  });

  it("does not reclassify unrelated routes as provisioning errors", async () => {
    const { app } = authorizedApp(true);
    const logger = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      for (const path of [
        "/auth/login",
        "/admin/mlflow/provision/other",
        "/admin/mlflow/provisioning",
      ]) {
        const response = await request(app)
          .post(path)
          .set("Content-Type", "application/json")
          .send('{"synthetic":');
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ status: "error" });
      }
      expect(
        (
          await request(app)
            .get("/health/live")
            .set("Content-Type", "application/json")
            .send('{"synthetic":')
        ).status,
      ).toBe(500);
      expect(logger).toHaveBeenCalledTimes(4);
    } finally {
      logger.mockRestore();
    }
  });
});
