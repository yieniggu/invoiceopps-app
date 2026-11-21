import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { SessionIntrospectionService } from "../../src/features/api-tokens/session-introspection.js";

const PATH = "/internal/sessions/introspect";
const SERVICE_SECRET = "s".repeat(48);
const SESSION = "session-cookie-value";

const ACTIVE = {
  active: true as const,
  userId: "user-1",
  contexts: [
    { organizationId: "org-1", groupId: null, label: "Org" },
    { organizationId: "org-1", groupId: "group-1", label: "Org / Group" },
  ],
  cacheTtlSeconds: 30,
};

function build(secret: string | undefined = SERVICE_SECRET) {
  const introspect = vi.fn(async () => ACTIVE);
  const service: SessionIntrospectionService = { introspect };
  const app = createApp({ isReady: async () => true }, undefined, {
    sessionIntrospection: service,
    internalServiceSecret: secret,
  });
  return { app, introspect };
}

const call = (app: ReturnType<typeof build>["app"]) =>
  request(app).post(PATH).set("Host", "127.0.0.1");

describe("POST /internal/sessions/introspect service credential (MLOPS-02)", () => {
  it("answers the session contexts to the service credential", async () => {
    const { app, introspect } = build();

    const response = await call(app)
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ sessionToken: SESSION });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ACTIVE);
    expect(response.headers["cache-control"]).toBe("private, max-age=30");
    expect(introspect).toHaveBeenCalledWith(SESSION);
  });

  it.each([
    ["no credential", undefined],
    ["a wrong credential", `Bearer ${"x".repeat(48)}`],
    ["the session itself as Bearer", `Bearer ${SESSION}`],
    ["a credential with another scheme", `Basic ${SERVICE_SECRET}`],
  ])("answers 401 and never introspects with %s", async (_label, header) => {
    const { app, introspect } = build();
    const test = call(app);
    if (header) test.set("Authorization", header);

    const response = await test.send({ sessionToken: SESSION });

    expect(response.status).toBe(401);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("cannot be called with a user session cookie", async () => {
    const { app, introspect } = build();

    const response = await call(app)
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", `invoiceops_session=${SESSION}`)
      .send({ sessionToken: SESSION });

    expect(response.status).toBe(401);
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
        .send({ sessionToken: SESSION });

      expect(response.status).toBe(401);
      expect(introspect).not.toHaveBeenCalled();
    },
  );

  it("answers 400 to a malformed body from the service", async () => {
    const { app, introspect } = build();

    for (const body of [
      {},
      { sessionToken: "" },
      { sessionToken: 7 },
      { token: SESSION },
    ]) {
      const response = await call(app)
        .set("Authorization", `Bearer ${SERVICE_SECRET}`)
        .send(body);
      expect(response.status).toBe(400);
    }
    expect(introspect).not.toHaveBeenCalled();
  });

  it("answers 401 when no session service is wired", async () => {
    const app = createApp({ isReady: async () => true }, undefined, {
      internalServiceSecret: SERVICE_SECRET,
    });

    const response = await call(app)
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ sessionToken: SESSION });

    expect(response.status).toBe(401);
  });

  it("is not part of the public API", async () => {
    const { app } = build();

    const response = await request(app)
      .post(`/api/v1${PATH}`)
      .set("Host", "127.0.0.1")
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ sessionToken: SESSION });

    expect(response.status).not.toBe(200);
  });
});
