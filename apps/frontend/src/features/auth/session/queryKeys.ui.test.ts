import { describe, expect, it } from "vitest";
import { partialMatchKey } from "@tanstack/react-query";

import { deploymentsKey, modelsKey } from "./queryKeys";

const context = { organizationId: "org", groupId: null };

describe("models and deployments keys (CR-568)", () => {
  it("never share a prefix, with or without a context", () => {
    // `partialMatchKey(key, prefix)`: would invalidating `prefix` hit `key`?
    expect(
      partialMatchKey(modelsKey("me", context), deploymentsKey("me")),
    ).toBe(false);
    expect(
      partialMatchKey(deploymentsKey("me", context), modelsKey("me")),
    ).toBe(false);
    expect(partialMatchKey(modelsKey("me", context), modelsKey("me"))).toBe(
      true,
    );
    expect(
      partialMatchKey(deploymentsKey("me", context), deploymentsKey("me")),
    ).toBe(true);
  });

  it("keep each context apart", () => {
    expect(modelsKey("me", context)).not.toEqual(
      modelsKey("me", { organizationId: "org", groupId: "g" }),
    );
    expect(deploymentsKey("me", context)).not.toEqual(
      deploymentsKey("other", context),
    );
  });
});
