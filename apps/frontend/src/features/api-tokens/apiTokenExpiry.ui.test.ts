import { describe, expect, it } from "vitest";

import {
  civilDate,
  describeExpiry,
  expiryBounds,
  MAX_EXPIRY_DAYS,
  resolveExpiry,
} from "./apiTokenExpiry";
import { formatInstant } from "../../lib/datetime";

const DAY = 86_400_000;
const MINUTE = 60_000;

/** What the server checks: strictly in the future, at most 30 days ahead. */
const acceptedBy = (expiresAt: string, serverNow: number) => {
  const remaining = Date.parse(expiresAt) - serverNow;
  return remaining > 0 && remaining <= 30 * DAY;
};

describe("resolveExpiry against a client clock that runs ahead (CR-320)", () => {
  const serverNow = Date.parse("2026-10-20T15:00:00.000Z");
  const clientNow = new Date(serverNow + 5 * MINUTE);

  it("keeps the longest preset inside the server limit", () => {
    const result = resolveExpiry({ choice: "29", date: "" }, clientNow);
    if ("error" in result) throw new Error(result.error);
    expect(acceptedBy(result.expiresAt, serverNow)).toBe(true);
    expect(Date.parse(result.expiresAt) - clientNow.getTime()).toBe(29 * DAY);
  });

  it("keeps the 7 day preset exact", () => {
    const result = resolveExpiry({ choice: "7", date: "" }, clientNow);
    expect(result).toEqual({
      expiresAt: new Date(clientNow.getTime() + 7 * DAY).toISOString(),
    });
  });

  it("clamps the last day of a custom date the same way", () => {
    const { max } = expiryBounds(clientNow);
    const result = resolveExpiry({ choice: "custom", date: max }, clientNow);
    if ("error" in result) throw new Error(result.error);
    expect(acceptedBy(result.expiresAt, serverNow)).toBe(true);
  });

  it("offers 29 days everywhere: picker, preset and copy agree (CR-346)", () => {
    expect(MAX_EXPIRY_DAYS).toBe(29);
    const now = new Date(2026, 9, 31, 12, 0, 0);
    expect(expiryBounds(now).max).toBe("2026-11-29");
    // The last day of the picker sends exactly the limit, not a later instant.
    const last = resolveExpiry({ choice: "custom", date: "2026-11-29" }, now);
    const preset = resolveExpiry({ choice: "29", date: "" }, now);
    expect(last).toEqual(preset);
    expect(
      resolveExpiry({ choice: "custom", date: "2026-11-30" }, now),
    ).toEqual({ error: "La caducidad no puede superar los 29 días." });
  });

  it("describes the real expiry that would be sent, live (CR-346)", () => {
    const now = new Date(2026, 9, 31, 12, 0, 0);
    const sent = resolveExpiry({ choice: "7", date: "" }, now);
    if ("error" in sent) throw new Error(sent.error);
    expect(describeExpiry({ choice: "7", date: "" }, now)).toBe(
      `Vence el ${formatInstant(sent.expiresAt)}`,
    );
    expect(describeExpiry({ choice: "custom", date: "" }, now)).toBeUndefined();
    expect(
      describeExpiry({ choice: "custom", date: "2026-11-29" }, now),
    ).toContain("29-11-2026");
  });

  it("still rejects a date beyond the 29 days", () => {
    const beyond = expiryBounds(new Date(clientNow.getTime() + 2 * DAY)).max;
    expect(
      resolveExpiry({ choice: "custom", date: beyond }, clientNow),
    ).toEqual({ error: "La caducidad no puede superar los 29 días." });
  });
});

describe("expiryBounds across a daylight-saving change (CR-366)", () => {
  // vite.config.ts pins America/Santiago: clocks go forward on 2026-09-06
  // (a 23 h day) and back on 2026-04-05 (a 25 h day).
  it("runs in the pinned zone", () => {
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(180);
    expect(new Date(2026, 5, 15, 12).getTimezoneOffset()).toBe(240);
  });

  it("keeps the 29th calendar day when clocks go forward in between", () => {
    const now = new Date(2026, 7, 8, 23, 30, 0);
    // 29 × 24 h later is already 2026-09-07 00:30 on the wall clock.
    expect(civilDate(new Date(now.getTime() + 29 * DAY))).toBe("2026-09-07");
    expect(expiryBounds(now).max).toBe("2026-09-06");
  });

  it("keeps the 29th calendar day when clocks go back in between", () => {
    const now = new Date(2026, 2, 7, 0, 30, 0);
    // 29 × 24 h later is still 2026-04-04 23:30 on the wall clock.
    expect(civilDate(new Date(now.getTime() + 29 * DAY))).toBe("2026-04-04");
    expect(expiryBounds(now).max).toBe("2026-04-05");
  });

  // CR-369: the last date offered must expire on that date, not the day before.
  it("clamps the last date to its own day when clocks go back in between", () => {
    const now = new Date(2026, 2, 7, 0, 30, 0);
    const { max } = expiryBounds(now);
    const result = resolveExpiry({ choice: "custom", date: max }, now);
    const expected = new Date(2026, 3, 5, 0, 30, 0);
    expect(result).toEqual({ expiresAt: expected.toISOString() });
    expect(civilDate(expected)).toBe(max);
    // 29 days and 1 hour: still inside the server's 30 days.
    expect(expected.getTime() - now.getTime()).toBe(29 * DAY + 3_600_000);
  });

  it("clamps the last date to its own day when clocks go forward in between", () => {
    const now = new Date(2026, 7, 8, 23, 30, 0);
    const { max } = expiryBounds(now);
    const result = resolveExpiry({ choice: "custom", date: max }, now);
    const expected = new Date(2026, 8, 6, 23, 30, 0);
    expect(result).toEqual({ expiresAt: expected.toISOString() });
    expect(civilDate(expected)).toBe(max);
  });
});
