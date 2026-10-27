import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
} from "./theme";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("resolveTheme", () => {
  it.each([
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
    [null, true, "dark"],
    [null, false, "light"],
  ] as const)("stored %s + system dark %s -> %s", (stored, dark, expected) => {
    expect(resolveTheme(stored, dark)).toBe(expected);
  });
});

describe("stored theme", () => {
  it("uses the invoiceops.theme key", () => {
    expect(THEME_STORAGE_KEY).toBe("invoiceops.theme");
  });

  it("round-trips light and dark and clears with null", () => {
    expect(readStoredTheme()).toBeNull();
    writeStoredTheme("dark");
    expect(window.localStorage.getItem("invoiceops.theme")).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
    writeStoredTheme("light");
    expect(readStoredTheme()).toBe("light");
    writeStoredTheme(null);
    expect(window.localStorage.getItem("invoiceops.theme")).toBeNull();
    expect(readStoredTheme()).toBeNull();
  });

  it("ignores unknown stored values", () => {
    window.localStorage.setItem("invoiceops.theme", "sepia");
    expect(readStoredTheme()).toBeNull();
  });

  it("survives storage that throws on every access", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => writeStoredTheme("dark")).not.toThrow();
    expect(() => writeStoredTheme(null)).not.toThrow();
  });

  it("survives a throwing localStorage accessor", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readStoredTheme()).toBeNull();
    expect(() => writeStoredTheme("light")).not.toThrow();
  });

  it("survives a missing localStorage", () => {
    vi.spyOn(window, "localStorage", "get").mockReturnValue(
      undefined as unknown as Storage,
    );
    expect(readStoredTheme()).toBeNull();
    expect(() => writeStoredTheme("dark")).not.toThrow();
  });
});
