import { describe, expect, it } from "vitest";

import { isUuid } from "./uuid";

describe("isUuid", () => {
  it("accepts canonical UUIDs of any case, as the server's z.uuid() does", () => {
    expect(isUuid("3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(isUuid("3F2B8C1E-5A4D-4E6F-9A0B-1C2D3E4F5A6B")).toBe(true);
    expect(isUuid("00000000-0000-4000-8000-000000000110")).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of [
      "",
      "user-110",
      "not-a-uuid",
      " 3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b",
      "3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6b ",
      "3f2b8c1e5a4d4e6f9a0b1c2d3e4f5a6b",
      "3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6",
      "3f2b8c1e-5a4d-4e6f-9a0b-1c2d3e4f5a6g",
      "3f2b8c1e-5a4d-9e6f-9a0b-1c2d3e4f5a6b",
      "3f2b8c1e-5a4d-4e6f-0a0b-1c2d3e4f5a6b",
      "../../etc/passwd",
    ])
      expect(isUuid(value), value).toBe(false);
  });
});
