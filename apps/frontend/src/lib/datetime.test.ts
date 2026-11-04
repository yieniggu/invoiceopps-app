import { describe, expect, it } from "vitest";

import { formatInstant } from "./datetime";

describe("formatInstant", () => {
  it("formats an ISO instant with date and time in es-CL", () => {
    const value = "2026-11-04T12:30:00.000Z";
    expect(formatInstant(value)).toBe(
      new Intl.DateTimeFormat("es-CL", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    );
  });

  it("says «Fecha no disponible» for an unreadable value", () => {
    expect(formatInstant("not-a-date")).toBe("Fecha no disponible");
  });
});
