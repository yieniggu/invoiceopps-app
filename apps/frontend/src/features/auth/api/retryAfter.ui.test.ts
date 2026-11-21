import { describe, expect, it } from "vitest";

import {
  ApiError,
  describeError,
  describeWait,
  formatWait,
  parseRetryAfter,
  readApiError,
} from "./apiError";

describe("Retry-After (CR-574)", () => {
  it("reads delta-seconds and HTTP dates, and ignores anything unusable", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter(" 120 ", now)).toBe(120);
    expect(parseRetryAfter("Fri, 20 Nov 2026 12:02:00 GMT", now)).toBe(120);
    expect(
      parseRetryAfter("Fri, 20 Nov 2026 11:00:00 GMT", now),
    ).toBeUndefined();
    expect(parseRetryAfter("0", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("99999999", now)).toBe(86_400);
  });

  it("formats the wait in the unit a person reads", () => {
    expect(formatWait(1)).toBe("1 s");
    expect(formatWait(45)).toBe("45 s");
    expect(formatWait(60)).toBe("1 min");
    expect(formatWait(61)).toBe("2 min");
    expect(formatWait(3600)).toBe("1 h");
  });

  it("is kept on the ApiError a 429 produces", async () => {
    const error = await readApiError(
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), {
        status: 429,
        headers: { "Retry-After": "90" },
      }),
    );
    expect(error.retryAfterSeconds).toBe(90);
    expect(describeError(error, "x")).toBe(
      "Demasiados intentos. Espera 2 min.",
    );
  });

  it("falls back to a generic wait when the header is missing", () => {
    const error = new ApiError(429, "RATE_LIMITED", "server");
    expect(describeWait(error)).toBe("Espera un momento.");
    expect(describeError(error, "x")).toBe(
      "Demasiados intentos. Espera un momento.",
    );
  });
});
