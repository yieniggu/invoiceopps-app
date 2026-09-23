import { describe, expect, it } from "vitest";

import { parsePlatformAdministratorCommand } from "../src/platform-administrator-command.js";

describe("bootstrap-platform-administrator command validation", () => {
  it.each<[unknown]>([
    [[]],
    [["invalid", "user-1", "--confirm-invalid"]],
    [["bootstrap"]],
    [["bootstrap", "user-1"]],
    [["bootstrap", "user-1", "--confirm-transfer"]],
    [["transfer", "user-1", "--confirm-bootstrap"]],
    [["transfer", "user-1", "--confirm-transfer", "unexpected"]],
  ])(
    "rejects invalid invocation %j before a command can execute",
    (arguments_) => {
      expect(() => parsePlatformAdministratorCommand(arguments_)).toThrow(
        "Usage: bootstrap-platform-administrator",
      );
    },
  );

  it("rejects missing or non-array argv with the usage error", () => {
    for (const arguments_ of [undefined, null, "bootstrap", {}]) {
      expect(() => parsePlatformAdministratorCommand(arguments_)).toThrow(
        "Usage: bootstrap-platform-administrator",
      );
    }
  });

  it("accepts only explicitly confirmed bootstrap and transfer commands", () => {
    expect(
      parsePlatformAdministratorCommand([
        "bootstrap",
        "user-1",
        "--confirm-bootstrap",
      ]),
    ).toEqual({ operation: "bootstrap", userId: "user-1" });
    expect(
      parsePlatformAdministratorCommand([
        "transfer",
        "user-2",
        "--confirm-transfer",
      ]),
    ).toEqual({ operation: "transfer", userId: "user-2" });
  });
});
