import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueApiTokenDialog } from "./components/IssueApiTokenDialog";
import { formatInstant } from "./apiTokenExpiry";
import type { ApiTokenInput } from "./types";

const options = [
  {
    value: "org:1",
    label: "Toda la organización",
    organizationId: "org-1",
    organizationName: "Norte",
    groupId: null,
    allowed: ["invoices:read" as const],
  },
];

function mount(onSubmit: (input: ApiTokenInput) => void = () => undefined) {
  return render(
    <IssueApiTokenDialog
      options={options}
      pending={false}
      failure={undefined}
      onSubmit={onSubmit}
      onClose={() => undefined}
      returnFocusTo={createRef<HTMLElement>()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DAY = 86_400_000;
/** The preview the dialog shows for an instant, built with the production helper. */
const preview = (instant: Date) =>
  `Vence el ${formatInstant(instant.toISOString())}`;

describe("expiry preview of an open emission dialog (CR-361)", () => {
  it("refreshes «Vence el …» on every minute and sends what it showed", () => {
    vi.useFakeTimers();
    const start = new Date(2026, 9, 31, 12, 0, 40);
    vi.setSystemTime(start);
    // The default expiry is 29 × 24 h from now, cut to the minute: expectations
    // add the same span, so a daylight-saving change in the local zone between
    // the two dates cannot move the shown hour.
    const expiry = (minutes: number) =>
      new Date(
        Math.floor(start.getTime() / 60_000) * 60_000 +
          29 * DAY +
          minutes * 60_000,
      );
    const sent: ApiTokenInput[] = [];
    mount((input) => sent.push(input));

    // Minute precision: the seconds are cut off.
    expect(screen.getByText(preview(expiry(0)))).toBeTruthy();

    // Left open past the next minute, the preview follows the clock.
    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(screen.getByText(preview(expiry(1)))).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(screen.getByText(preview(expiry(6)))).toBeTruthy();

    // Submitted within the same minute, the sent instant is the shown one.
    fireEvent.change(screen.getByLabelText("Nombre del token"), {
      target: { value: "Robot" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Leer facturas" }));
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Emitir token" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].expiresAt).toBe(expiry(6).toISOString());
    expect(`Vence el ${formatInstant(sent[0].expiresAt)}`).toBe(
      preview(expiry(6)),
    );
  });

  it("stops its timer when the dialog goes away", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 31, 12, 0, 0));
    const view = mount();
    const mounted = vi.getTimerCount();
    view.unmount();
    // The minute tick is cleared (nothing else of the dialog is a timer).
    expect(vi.getTimerCount()).toBeLessThan(mounted);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
  });
});
