import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { ApiTokenIntrospectionService } from "../../src/features/api-tokens/introspection.js";

const PATH = "/internal/api-tokens/introspect";
const SERVICE_SECRET = "s".repeat(48);
const USER_TOKEN = `iop_${"a".repeat(43)}`;

const ACTIVE = {
  active: true as const,
  userId: "user-1",
  organizationId: "org-1",
  groupId: null,
  scopes: ["mlflow:read" as const],
  cacheTtlSeconds: 30,
};

function build(secret: string | undefined = SERVICE_SECRET) {
  const introspect = vi.fn(async () => ACTIVE);
  const service: ApiTokenIntrospectionService = { introspect };
  const app = createApp({ isReady: async () => true }, undefined, {
    apiTokenIntrospection: service,
    internalServiceSecret: secret,
  });
  return { app, introspect };
}

const call = (app: ReturnType<typeof build>["app"]) =>
  request(app).post(PATH).set("Host", "127.0.0.1");

describe("POST /internal/api-tokens/introspect service credential (MLOPS-01)", () => {
  it("answers the introspection payload to the service credential", async () => {
    const { app, introspect } = build();

    const response = await call(app)
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ token: USER_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ACTIVE);
    expect(response.headers["cache-control"]).toBe("private, max-age=30");
    expect(introspect).toHaveBeenCalledWith(USER_TOKEN);
  });

  it.each([
    ["no credential", undefined],
    ["a wrong credential", `Bearer ${"x".repeat(48)}`],
    ["a user API token", `Bearer ${USER_TOKEN}`],
    ["a credential with another scheme", `Basic ${SERVICE_SECRET}`],
    ["a bare credential", SERVICE_SECRET],
  ])("answers 401 and never introspects with %s", async (_label, header) => {
    const { app, introspect } = build();
    const test = call(app);
    if (header) test.set("Authorization", header);

    const response = await test.send({ token: USER_TOKEN });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(introspect).not.toHaveBeenCalled();
  });

  it("cannot be called with a user session cookie", async () => {
    const { app, introspect } = build();

    const response = await call(app)
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=session-token")
      .send({ token: USER_TOKEN });

    expect(response.status).toBe(401);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("cannot be called with a user session cookie from a foreign origin", async () => {
    const { app, introspect } = build();

    const response = await call(app)
      .set("Origin", "http://evil.example")
      .set("Cookie", "invoiceops_session=session-token")
      .send({ token: USER_TOKEN });

    expect(response.status).toBe(403);
    expect(introspect).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["shorter than 32 characters", "short-secret"],
  ])(
    "fails closed when the configured secret is %s",
    async (_label, secret) => {
      const { app, introspect } = build(secret);

      const response = await call(app)
        .set("Authorization", `Bearer ${secret || "anything"}`)
        .send({ token: USER_TOKEN });

      expect(response.status).toBe(401);
      expect(introspect).not.toHaveBeenCalled();
    },
  );

  it("answers 400 to a malformed body from the service", async () => {
    const { app, introspect } = build();

    for (const body of [
      {},
      { token: "" },
      { token: 7 },
      { token: "a", x: 1 },
    ]) {
      const response = await call(app)
        .set("Authorization", `Bearer ${SERVICE_SECRET}`)
        .send(body);
      // An extra field is ignored; the others are invalid.
      expect(response.status).toBe("x" in body ? 200 : 400);
    }
    expect(introspect).toHaveBeenCalledTimes(1);
  });

  it("is not part of the public API: no route under /api/v1 and no OpenAPI path", async () => {
    const { app } = build();

    const publicRoute = await request(app)
      .post(`/api/v1${PATH}`)
      .set("Host", "127.0.0.1")
      .send({ token: USER_TOKEN });
    const document = await request(app).get("/openapi.json");

    expect(publicRoute.status).toBe(404);
    expect(JSON.stringify(document.body.paths)).not.toContain("/internal");
  });
});
