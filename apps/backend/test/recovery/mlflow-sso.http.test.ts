import { afterEach, describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import {
  mlflowCallbackUrlFromEnv,
  MLFLOW_CALLBACK_PATH,
} from "../../src/features/mlflow-sso/config.js";
import { createMlflowSsoService } from "../../src/features/mlflow-sso/service.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type {
  AuthorizeResult,
  MlflowSsoService,
} from "../../src/features/mlflow-sso/service.js";

const CALLBACK = "https://mlflow.example.test/_gateway/callback";
const SERVICE_SECRET = "s".repeat(48);
const SESSION = "app-session-token";
const STATE = "a".repeat(22);
const AUTHORIZE = "/api/v1/mlflow/authorize";

function build(
  result: AuthorizeResult = { status: "issued", code: "the-code" },
  callbackUrl: string | null = CALLBACK,
) {
  const authorize = vi.fn(async () => result);
  const exchange = vi.fn(async () => ({
    sessionToken: "mls_child",
    expiresInSeconds: 120,
  }));
  const revoke = vi.fn(async () => {});
  const service: MlflowSsoService = { authorize, exchange, revoke };
  const app = createApp({ isReady: async () => true }, undefined, {
    mlflowSso: service,
    mlflowCallbackUrl: callbackUrl ?? undefined,
    internalServiceSecret: SERVICE_SECRET,
  });
  return { app, authorize, exchange, revoke };
}

const authorizeCall = (
  app: ReturnType<typeof build>["app"],
  query: Record<string, string>,
  cookie: string | null = `invoiceops_session=${SESSION}`,
) => {
  const test = request(app)
    .get(AUTHORIZE)
    .query(query)
    .set("Host", "127.0.0.1");
  return cookie ? test.set("Cookie", cookie) : test;
};

describe("GET /api/v1/mlflow/authorize", () => {
  it("redirects to the configured callback with the code and the echoed state", async () => {
    const { app, authorize } = build();

    const response = await authorizeCall(app, {
      redirect_uri: CALLBACK,
      state: STATE,
    });

    expect(response.status).toBe(302);
    const target = new URL(response.headers.location as string);
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK);
    expect(target.searchParams.get("code")).toBe("the-code");
    expect(target.searchParams.get("state")).toBe(STATE);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(authorize).toHaveBeenCalledWith(SESSION);
  });

  it("sends a visitor without a session to the sign-in page and issues nothing", async () => {
    const { app, authorize } = build({ status: "unauthenticated" });

    for (const cookie of [null, `invoiceops_session=${SESSION}`]) {
      const response = await authorizeCall(
        app,
        { redirect_uri: CALLBACK, state: STATE },
        cookie,
      );
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    }
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another host", "https://evil.example/_gateway/callback"],
    ["another path", "https://mlflow.example.test/other"],
    ["a trailing slash", `${CALLBACK}/`],
    ["a query", `${CALLBACK}?x=1`],
    ["another scheme", CALLBACK.replace("https", "http")],
    ["a case variation", CALLBACK.toUpperCase()],
    [
      "a userinfo trick",
      "https://mlflow.example.test@evil.example/_gateway/callback",
    ],
    ["an empty value", ""],
  ])("answers 400 and never redirects for %s", async (_label, redirectUri) => {
    const { app, authorize } = build();

    const response = await authorizeCall(app, {
      redirect_uri: redirectUri,
      state: STATE,
    });

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects a missing, repeated or malformed redirect_uri and state", async () => {
    const { app, authorize } = build();

    const cases = [
      authorizeCall(app, { state: STATE }),
      authorizeCall(app, { redirect_uri: CALLBACK }),
      authorizeCall(app, { redirect_uri: CALLBACK, state: "short" }),
      authorizeCall(app, {
        redirect_uri: CALLBACK,
        state: "bad state!!!!!!!!!!!!!!",
      }),
      request(app)
        .get(
          `${AUTHORIZE}?redirect_uri=${encodeURIComponent(CALLBACK)}&redirect_uri=${encodeURIComponent(CALLBACK)}&state=${STATE}`,
        )
        .set("Host", "127.0.0.1")
        .set("Cookie", `invoiceops_session=${SESSION}`),
    ];
    for (const pending of cases) {
      const response = await pending;
      expect(response.status).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
    expect(authorize).not.toHaveBeenCalled();
  });

  it("answers 403 for an account without MLflow access and 503 when unconfigured", async () => {
    const denied = build({ status: "no_access" });
    const noAccess = await authorizeCall(denied.app, {
      redirect_uri: CALLBACK,
      state: STATE,
    });
    expect(noAccess.status).toBe(403);
    expect(noAccess.headers.location).toBeUndefined();

    const off = build(undefined, null);
    const unconfigured = await authorizeCall(off.app, {
      redirect_uri: CALLBACK,
      state: STATE,
    });
    expect(unconfigured.status).toBe(503);
  });
});

describe("private exchange and revoke routes", () => {
  const post = (
    app: ReturnType<typeof build>["app"],
    path: string,
    body: unknown,
    credential?: string,
  ) => {
    const test = request(app).post(path).set("Host", "127.0.0.1");
    if (credential) test.set("Authorization", `Bearer ${credential}`);
    return test.send(body as object);
  };

  it("exchanges a code for the child token with the service credential", async () => {
    const { app, exchange } = build();

    const response = await post(
      app,
      "/internal/sessions/exchange",
      { code: "the-code" },
      SERVICE_SECRET,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      active: true,
      sessionToken: "mls_child",
      expiresInSeconds: 120,
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(exchange).toHaveBeenCalledWith("the-code");
  });

  it.each([
    ["/internal/sessions/exchange", { code: "c" }],
    ["/internal/sessions/revoke", { sessionToken: "t" }],
  ])("%s refuses everything but the service credential", async (path, body) => {
    const { app, exchange, revoke } = build();

    for (const credential of [undefined, "x".repeat(48), SESSION]) {
      expect((await post(app, path, body, credential)).status).toBe(401);
    }
    const asUser = await request(app)
      .post(path)
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", `invoiceops_session=${SESSION}`)
      .send(body);
    expect(asUser.status).toBe(401);
    expect(exchange).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("answers inactive without a reason when the exchange fails", async () => {
    const { app, exchange } = build();
    exchange.mockResolvedValueOnce(null as never);

    const response = await post(
      app,
      "/internal/sessions/exchange",
      { code: "used" },
      SERVICE_SECRET,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ active: false });
  });

  it("revokes a child session and rejects malformed bodies", async () => {
    const { app, revoke } = build();

    const ok = await post(
      app,
      "/internal/sessions/revoke",
      { sessionToken: "mls_child" },
      SERVICE_SECRET,
    );
    expect(ok.status).toBe(204);
    expect(revoke).toHaveBeenCalledWith("mls_child");

    for (const body of [{}, { sessionToken: "" }, { token: "x" }]) {
      expect(
        (await post(app, "/internal/sessions/revoke", body, SERVICE_SECRET))
          .status,
      ).toBe(400);
    }
  });

  it("is not part of the public API", async () => {
    const { app } = build();

    const response = await post(
      app,
      "/api/v1/internal/sessions/exchange",
      { code: "c" },
      SERVICE_SECRET,
    );

    expect(response.status).not.toBe(200);
  });
});

describe("GET /api/v1/mlflow/authorize rate limit", () => {
  const query = { redirect_uri: CALLBACK, state: STATE };

  it("answers 429 with Retry-After after 30 requests of one session in a minute", async () => {
    const { app, authorize } = build();

    for (let index = 0; index < 30; index += 1) {
      expect((await authorizeCall(app, query)).status).toBe(302);
    }
    const blocked = await authorizeCall(app, query);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.headers.location).toBeUndefined();
    expect(authorize).toHaveBeenCalledTimes(30);
  });

  it("limits each session on its own", async () => {
    const { app } = build();

    for (let index = 0; index < 31; index += 1) {
      await authorizeCall(app, query);
    }
    const other = await authorizeCall(
      app,
      query,
      "invoiceops_session=another-session",
    );

    expect(other.status).toBe(302);
  });
});

describe("GET /api/v1/mlflow/authorize limiter keys (CR-512)", () => {
  const query = { redirect_uri: CALLBACK, state: STATE };

  it("keys a rejected cookie by IP, so rotating random cookies cannot mint fresh buckets", async () => {
    const { app, authorize } = build({ status: "unauthenticated" });

    for (let index = 0; index < 30; index += 1) {
      const response = await authorizeCall(
        app,
        query,
        `invoiceops_session=random-${index}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    }
    // A thirty-first, different, invalid cookie from the same client: blocked.
    const blocked = await authorizeCall(
      app,
      query,
      "invoiceops_session=random-final",
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(authorize).toHaveBeenCalledTimes(30);
  });

  it("does not charge the IP for a validated session, which has its own bucket", async () => {
    const { app } = build();

    for (let index = 0; index < 25; index += 1) {
      expect((await authorizeCall(app, query)).status).toBe(302);
    }
    // An invalid cookie still has its whole IP budget: valid sessions did not spend it.
    const invalid = build({ status: "unauthenticated" });
    expect(
      (await authorizeCall(invalid.app, query, "invoiceops_session=nope"))
        .status,
    ).toBe(302);
  });
});

describe("mlflowCallbackUrlFromEnv", () => {
  it("derives the callback from the MLflow origin", () => {
    expect(
      mlflowCallbackUrlFromEnv({
        MLFLOW_PUBLIC_URL: "https://mlflow-invoiceops.aglai.dev",
        NODE_ENV: "production",
      }),
    ).toBe(`https://mlflow-invoiceops.aglai.dev${MLFLOW_CALLBACK_PATH}`);
    expect(
      mlflowCallbackUrlFromEnv({ MLFLOW_PUBLIC_URL: "https://m.test/" }),
    ).toBe(`https://m.test${MLFLOW_CALLBACK_PATH}`);
  });

  it("stays off when unset or blank", () => {
    expect(mlflowCallbackUrlFromEnv({})).toBeUndefined();
    expect(
      mlflowCallbackUrlFromEnv({ MLFLOW_PUBLIC_URL: "  " }),
    ).toBeUndefined();
  });

  it.each([
    ["a path", "https://m.test/mlflow", undefined],
    ["a query", "https://m.test/?a=1", undefined],
    ["a fragment", "https://m.test/#x", undefined],
    ["credentials", "https://u:p@m.test", undefined],
    ["a non-http scheme", "ftp://m.test", undefined],
    ["a non-URL", "mlflow", undefined],
    ["plain http in production", "http://m.test", "production"],
  ])("refuses to start with %s", (_label, value, nodeEnv) => {
    expect(() =>
      mlflowCallbackUrlFromEnv({ MLFLOW_PUBLIC_URL: value, NODE_ENV: nodeEnv }),
    ).toThrow(/MLFLOW_PUBLIC_URL/);
  });

  // Same table as the gateway's test_origins_are_normalized_like_the_app: both
  // sides must turn the same configured value into the same origin string.
  it.each([
    ["https://MLflow.Example.TEST", "https://mlflow.example.test"],
    ["HTTPS://mlflow.example.test:443/", "https://mlflow.example.test"],
    ["https://mlflow.example.test:8443", "https://mlflow.example.test:8443"],
    ["  https://mlflow.example.test/  ", "https://mlflow.example.test"],
  ])("normalizes %s to %s like the gateway", (raw, origin) => {
    expect(mlflowCallbackUrlFromEnv({ MLFLOW_PUBLIC_URL: raw })).toBe(
      `${origin}${MLFLOW_CALLBACK_PATH}`,
    );
  });

  it("allows plain http outside production", () => {
    expect(
      mlflowCallbackUrlFromEnv({ MLFLOW_PUBLIC_URL: "http://localhost:8080" }),
    ).toBe(`http://localhost:8080${MLFLOW_CALLBACK_PATH}`);
  });
});

describe("exchange under connection-pool pressure (CR-524)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers 503 RETRYABLE_CONFLICT with Retry-After when the transaction cannot start (P2028)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi.fn(async (_run: unknown, _options: unknown) => {
      throw Object.assign(
        new Error("Unable to start a transaction in the given time"),
        { code: "P2028" },
      );
    });
    const service = createMlflowSsoService({
      $transaction: transaction,
    } as unknown as PrismaClient);
    const app = createApp({ isReady: async () => true }, undefined, {
      mlflowSso: service,
      mlflowCallbackUrl: CALLBACK,
      internalServiceSecret: SERVICE_SECRET,
    });

    const response = await request(app)
      .post("/internal/sessions/exchange")
      .set("Host", "127.0.0.1")
      .set("Authorization", `Bearer ${SERVICE_SECRET}`)
      .send({ code: "the-code" });

    expect(response.status).toBe(503);
    expect(response.body.error?.code ?? response.body.code).toBe(
      "RETRYABLE_CONFLICT",
    );
    expect(response.headers["retry-after"]).toBe("1");
    // An explicit maxWait/timeout is always passed to Prisma.
    expect(transaction.mock.calls[0]?.[1]).toMatchObject({
      maxWait: expect.any(Number),
      timeout: expect.any(Number),
    });
  });
});
