import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import {
  SERVICE_GUARD_MAX_FAILURES,
  type ApiTokenIntrospectionService,
} from "../../src/features/api-tokens/introspection.js";
import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";

const SECRET = "9f2c7e41b8d05a6c3e19f7a2d4b80c65";
const PATHS = [
  "/internal/api-tokens/introspect",
  "/internal/sessions/introspect",
  "/internal/sessions/exchange",
  "/internal/sessions/revoke",
];

function build(options: { now?: () => number; trustProxyHops?: number } = {}) {
  const introspect = vi.fn(async () => ({
    active: false as const,
    cacheTtlSeconds: 5,
  }));
  const service: ApiTokenIntrospectionService = { introspect };
  const limiter = createAuthRateLimiter({
    maxAttempts: SERVICE_GUARD_MAX_FAILURES,
    windowMs: 60_000,
    now: options.now,
  });
  const app = createApp({ isReady: async () => true }, undefined, {
    apiTokenIntrospection: service,
    internalServiceSecret: SECRET,
    internalAuthLimiter: limiter,
    trustProxyHops: options.trustProxyHops,
  });
  return { app, introspect };
}

const call = (
  app: ReturnType<typeof build>["app"],
  path: string,
  secret: string | null,
) => {
  const test = request(app).post(path).send({ token: "iop_x" });
  return secret === null ? test : test.set("Authorization", `Bearer ${secret}`);
};

describe("per-IP throttle of the internal guard (CR-512)", () => {
  it("answers 429 with Retry-After after too many wrong credentials, on every internal route", async () => {
    const { app } = build();

    for (let index = 0; index < SERVICE_GUARD_MAX_FAILURES; index += 1) {
      // Spread the guesses across the four routes: they share one budget.
      const path = PATHS[index % PATHS.length]!;
      expect((await call(app, path, `wrong-${index}`)).status).toBe(401);
    }
    for (const path of PATHS) {
      const blocked = await call(app, path, "wrong-again");
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("RATE_LIMITED");
      expect(blocked.headers["retry-after"]).toBe("60");
    }
  });

  it("keeps refusing wrong credentials once the IP is locked, without reaching the service", async () => {
    const { app, introspect } = build();
    for (let index = 0; index < SERVICE_GUARD_MAX_FAILURES; index += 1) {
      await call(app, PATHS[0]!, null);
    }
    expect((await call(app, PATHS[0]!, "wrong")).status).toBe(429);
    expect(introspect).not.toHaveBeenCalled();
  });

  it("lets the valid credential through after a spoofed X-Forwarded-For exhausts the limit (CR-532)", async () => {
    const { app, introspect } = build({ trustProxyHops: 1 });
    const gatewayIp = "10.1.2.3";
    const withIp = (secret: string | null) =>
      call(app, PATHS[0]!, secret).set("X-Forwarded-For", gatewayIp);
    for (let index = 0; index < SERVICE_GUARD_MAX_FAILURES; index += 1) {
      expect((await withIp(`wrong-${index}`)).status).toBe(401);
    }
    expect((await withIp("wrong-again")).status).toBe(429);
    expect((await withIp(SECRET)).status).toBe(200);
    expect(introspect).toHaveBeenCalledTimes(1);
  });

  it("never charges a valid credential", async () => {
    const { app, introspect } = build();
    for (let index = 0; index < SERVICE_GUARD_MAX_FAILURES * 2; index += 1) {
      expect((await call(app, PATHS[0]!, SECRET)).status).toBe(200);
    }
    expect(introspect).toHaveBeenCalledTimes(SERVICE_GUARD_MAX_FAILURES * 2);
  });

  it("forgets the failures when the window ends", async () => {
    let clock = 1_000_000;
    const { app } = build({ now: () => clock });
    for (let index = 0; index < SERVICE_GUARD_MAX_FAILURES; index += 1) {
      await call(app, PATHS[0]!, "wrong");
    }
    expect((await call(app, PATHS[0]!, "wrong")).status).toBe(429);
    clock += 61_000;
    expect((await call(app, PATHS[0]!, "wrong")).status).toBe(401);
    expect((await call(app, PATHS[0]!, SECRET)).status).toBe(200);
  });
});
