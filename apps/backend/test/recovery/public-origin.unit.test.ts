import { describe, expect, it } from "vitest";

import { publicOriginFromEnv } from "../../src/http/public-origin.js";

describe("PUBLIC_ORIGIN parsing", () => {
  it.each([undefined, "", "   "])("leaves the check unset for %j", (value) => {
    expect(publicOriginFromEnv(value)).toBeUndefined();
  });

  it.each([
    ["https://invoiceops.aglai.dev", "https://invoiceops.aglai.dev"],
    [" https://invoiceops.aglai.dev ", "https://invoiceops.aglai.dev"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["https://localhost:8443", "https://localhost:8443"],
  ])("accepts %j", (value, origin) => {
    expect(publicOriginFromEnv(value)).toBe(origin);
  });

  it.each([
    "invoiceops.aglai.dev",
    "ftp://invoiceops.aglai.dev",
    "https://invoiceops.aglai.dev/",
    "https://invoiceops.aglai.dev/app",
    "https://invoiceops.aglai.dev?x=1",
    "https://invoiceops.aglai.dev#frag",
    "https://user@invoiceops.aglai.dev",
    "https://INVOICEOPS.aglai.dev",
    "https://invoiceops.aglai.dev:443",
    "null",
    "*",
  ])("aborts startup for the invalid value %j", (value) => {
    expect(() => publicOriginFromEnv(value)).toThrow(
      "PUBLIC_ORIGIN must be an absolute http(s) origin",
    );
  });
});
