import { describe, expect, it } from "vitest";

import { ApiError, describeError } from "./apiError";

describe("describeError", () => {
  it("explains RETRYABLE_CONFLICT in Spanish without the server message", () => {
    const error = new ApiError(503, "RETRYABLE_CONFLICT", "server text");

    expect(describeError(error, "fallback")).toBe(
      "El sistema está ocupado. Intenta nuevamente en unos segundos.",
    );
  });
});
