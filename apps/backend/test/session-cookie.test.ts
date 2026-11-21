import { describe, expect, it } from "vitest";

import { sessionTokenFromCookie } from "../src/features/auth/session.js";

describe("sessionTokenFromCookie", () => {
  it("reads a single session cookie among others", () => {
    expect(sessionTokenFromCookie("a=1; invoiceops_session=tok=en; b=2")).toBe(
      "tok=en",
    );
  });

  it("returns undefined without a header or cookie", () => {
    expect(sessionTokenFromCookie(undefined)).toBeUndefined();
    expect(sessionTokenFromCookie("other=1")).toBeUndefined();
  });

  it("treats repeated session cookies as no session (cookie tossing)", () => {
    expect(
      sessionTokenFromCookie("invoiceops_session=a; invoiceops_session=b"),
    ).toBeUndefined();
    expect(
      sessionTokenFromCookie("invoiceops_session=a; x=1; invoiceops_session="),
    ).toBeUndefined();
  });
});
