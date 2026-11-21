import { describe, expect, it } from "vitest";

import {
  POLL_FIRST_MS,
  POLL_GIVE_UP_MS,
  POLL_MAX_MS,
  pollDelay,
} from "./boundedPolling";

describe("pollDelay", () => {
  it("starts at 2 s, grows with the run and stops growing at 10 s", () => {
    expect(pollDelay(0)).toBe(POLL_FIRST_MS);
    expect(pollDelay(4_000)).toBe(2_000);
    expect(pollDelay(6_000)).toBe(3_000);
    expect(pollDelay(13_000)).toBe(6_500);
    expect(pollDelay(60_000)).toBe(POLL_MAX_MS);
  });

  it("gives up after about two minutes", () => {
    expect(pollDelay(POLL_GIVE_UP_MS - 1)).toBe(POLL_MAX_MS);
    expect(pollDelay(POLL_GIVE_UP_MS)).toBe(false);
    expect(pollDelay(POLL_GIVE_UP_MS * 3)).toBe(false);
  });

  it("is pure: a clock that went backwards counts as the start", () => {
    expect(pollDelay(-5_000)).toBe(POLL_FIRST_MS);
    expect(pollDelay(6_000)).toBe(pollDelay(6_000));
  });
});
