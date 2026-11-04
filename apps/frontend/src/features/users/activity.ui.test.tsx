import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { formatInstant } from "../../lib/datetime";
import { describeActivity } from "./activity";
import { ActivityIndicator } from "./components/ActivityIndicator";

afterEach(cleanup);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("describeActivity", () => {
  it("is «Nunca» (gray) when the user has never been active", () => {
    expect(describeActivity(null, NOW)).toEqual({
      tone: "never",
      label: "Nunca",
    });
  });

  it("treats an unreadable timestamp as never active", () => {
    expect(describeActivity("not-a-date", NOW).tone).toBe("never");
  });

  it.each([
    [0, "Activo hace menos de 1 min"],
    [59 * 1000, "Activo hace menos de 1 min"],
    [1 * MINUTE, "Activo hace 1 min"],
    [59 * MINUTE + 59 * 1000, "Activo hace 59 min"],
    [1 * HOUR, "Activo hace 1 h"],
    [23 * HOUR + 59 * MINUTE, "Activo hace 23 h"],
  ])("is green under one day: %i ms ago → %s", (elapsed, label) => {
    expect(describeActivity(ago(elapsed), NOW)).toEqual({
      tone: "day",
      label,
    });
  });

  it.each([
    [1 * DAY, "Activo hace 1 d"],
    [6 * DAY + 23 * HOUR + 59 * MINUTE, "Activo hace 6 d"],
  ])(
    "is yellow from one day to under seven: %i ms ago → %s",
    (elapsed, label) => {
      expect(describeActivity(ago(elapsed), NOW)).toEqual({
        tone: "week",
        label,
      });
    },
  );

  it.each([
    [7 * DAY, "Activo hace 7 d"],
    [400 * DAY, "Activo hace 400 d"],
  ])("is red from seven days on: %i ms ago → %s", (elapsed, label) => {
    expect(describeActivity(ago(elapsed), NOW)).toEqual({
      tone: "stale",
      label,
    });
  });

  it("counts a timestamp ahead of the reference (clock skew) as just now", () => {
    expect(describeActivity(ago(-5 * MINUTE), NOW)).toEqual({
      tone: "day",
      label: "Activo hace menos de 1 min",
    });
  });
});

describe("ActivityIndicator", () => {
  it("shows the label in a <time> with the exact instant, and a decorative dot", () => {
    const lastActiveAt = ago(3 * HOUR);
    const { container, getByText } = render(
      <ActivityIndicator lastActiveAt={lastActiveAt} now={NOW} />,
    );
    const indicator = container.querySelector(".activity-indicator");
    expect(indicator?.classList.contains("is-day")).toBe(true);
    const dot = container.querySelector(".activity-dot");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    const time = container.querySelector("time");
    expect(time?.getAttribute("dateTime")).toBe(lastActiveAt);
    // No title: it would be a second, duplicated accessible description.
    expect(time?.hasAttribute("title")).toBe(false);
    // The state never depends on color alone: the text says it, and the exact
    // instant reaches assistive technology without widening the cell.
    expect(indicator?.textContent).toBe(
      `Activo hace 3 h (${formatInstant(lastActiveAt)})`,
    );
    const instant = getByText(`(${formatInstant(lastActiveAt)})`);
    expect(instant.className).toBe("visually-hidden");
    expect(getByText("Activo hace 3 h").tagName).toBe("SPAN");
  });

  it("shows the exact instant as visible text when detailed", () => {
    const lastActiveAt = ago(3 * HOUR);
    const { getByText } = render(
      <ActivityIndicator lastActiveAt={lastActiveAt} now={NOW} detailed />,
    );
    expect(getByText(`(${formatInstant(lastActiveAt)})`).className).toBe(
      "activity-instant",
    );
  });

  it.each([
    [ago(2 * DAY), "is-week"],
    [ago(8 * DAY), "is-stale"],
  ])("marks the tone of %s with %s", (lastActiveAt, tone) => {
    const { container } = render(
      <ActivityIndicator lastActiveAt={lastActiveAt} now={NOW} />,
    );
    expect(
      container.querySelector(".activity-indicator")?.classList.contains(tone),
    ).toBe(true);
  });

  it("says «Nunca» without a <time> when the user has never been active", () => {
    const { container } = render(
      <ActivityIndicator lastActiveAt={null} now={NOW} />,
    );
    const indicator = container.querySelector(".activity-indicator");
    expect(indicator?.classList.contains("is-never")).toBe(true);
    expect(indicator?.textContent).toBe("Nunca");
    expect(container.querySelector("time")).toBeNull();
  });
});
