import { describe, expect, it } from "vitest";

import {
  defaultDevelopmentPorts,
  developmentPorts,
  e2ePort,
} from "../../scripts/e2e-ports.mjs";

// CR-261: the browser suite recreates its database and may reuse the servers
// it finds, so it must never be pointed at the development stack's ports.

describe("E2E ports", () => {
  it("defaults to the dedicated ports", () => {
    expect(e2ePort("E2E_BACKEND_PORT", 4391, {})).toBe(4391);
    expect(e2ePort("E2E_FRONTEND_PORT", 5391, { E2E_FRONTEND_PORT: " " })).toBe(
      5391,
    );
  });

  it("accepts another free port", () => {
    expect(
      e2ePort("E2E_BACKEND_PORT", 4391, { E2E_BACKEND_PORT: "4500" }),
    ).toBe(4500);
  });

  it.each(defaultDevelopmentPorts)(
    "refuses the development port %i",
    (port) => {
      expect(() =>
        e2ePort("E2E_BACKEND_PORT", 4391, { E2E_BACKEND_PORT: String(port) }),
      ).toThrow(/development port/);
    },
  );

  it("refuses a port the development configuration moved to (.env)", () => {
    for (const name of [
      "PORT",
      "BACKEND_PORT",
      "FRONTEND_PORT",
      "LOCAL_BACKEND_PORT",
      "LOCAL_FRONTEND_PORT",
    ]) {
      const env = { [name]: "4777", E2E_BACKEND_PORT: "4777" };
      expect(developmentPorts(env).has(4777), name).toBe(true);
      expect(() => e2ePort("E2E_BACKEND_PORT", 4391, env), name).toThrow(
        /development port/,
      );
    }
  });

  it.each(["abc", "80", "70000", "4391.5", "-1"])(
    "refuses %j as not a usable port",
    (value) => {
      expect(() =>
        e2ePort("E2E_BACKEND_PORT", 4391, { E2E_BACKEND_PORT: value }),
      ).toThrow(/between 1024 and 65535/);
    },
  );

  it("keeps its own defaults out of the development set", () => {
    expect(developmentPorts({}).has(4391)).toBe(false);
    expect(developmentPorts({}).has(5391)).toBe(false);
  });
});
