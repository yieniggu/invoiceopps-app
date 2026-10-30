import { afterEach, describe, expect, it, vi } from "vitest";

import {
  invoiceCountText,
  invoiceRangeText,
  isOverdue,
  todayCivilDate,
} from "./invoicePresentation";

describe("isOverdue", () => {
  const today = "2026-10-29";

  it("is true only for a PENDING invoice whose due day is before today", () => {
    expect(
      isOverdue({ businessStatus: "PENDING", dueOn: "2026-10-28" }, today),
    ).toBe(true);
    expect(
      isOverdue({ businessStatus: "PENDING", dueOn: "2026-10-29" }, today),
    ).toBe(false);
    expect(
      isOverdue({ businessStatus: "PENDING", dueOn: "2026-11-01" }, today),
    ).toBe(false);
    for (const businessStatus of ["APPROVED", "REJECTED", "CANCELLED"])
      expect(isOverdue({ businessStatus, dueOn: "2020-01-01" }, today)).toBe(
        false,
      );
  });

  it("ignores a due date it cannot read", () => {
    expect(
      isOverdue({ businessStatus: "PENDING", dueOn: "mañana" }, today),
    ).toBe(false);
  });
});

describe("todayCivilDate (business time zone America/Santiago)", () => {
  afterEach(() => vi.useRealTimers());

  it("is the Santiago day, whatever the host time zone", () => {
    // Summer time (UTC-3): 01:30Z is still the previous evening in Santiago.
    expect(todayCivilDate(new Date("2026-10-29T01:30:00Z"))).toBe("2026-10-28");
    expect(todayCivilDate(new Date("2026-10-29T03:00:00Z"))).toBe("2026-10-29");
    // Winter time (UTC-4).
    expect(todayCivilDate(new Date("2026-07-01T03:59:00Z"))).toBe("2026-06-30");
    expect(todayCivilDate(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
  });

  it("zero-pads month and day", () => {
    expect(todayCivilDate(new Date("2026-01-05T15:00:00Z"))).toBe("2026-01-05");
  });

  it("drives «Vencida» by default: due yesterday in Santiago, today in UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T01:30:00Z"));
    const invoice = { businessStatus: "PENDING", dueOn: "2026-10-28" };
    // It is still the 28th in Santiago, so it is not past due yet.
    expect(isOverdue(invoice)).toBe(false);
    vi.setSystemTime(new Date("2026-10-29T03:00:00Z"));
    expect(isOverdue(invoice)).toBe(true);
  });
});

describe("invoice counts", () => {
  it("uses the singular for one invoice", () => {
    expect(invoiceCountText(1)).toBe("1 factura");
    expect(invoiceCountText(0)).toBe("0 facturas");
    expect(invoiceCountText(57)).toBe("57 facturas");
  });

  it("says which rows of the total a page shows", () => {
    expect(invoiceRangeText(1, 20, 57, 20)).toBe("Mostrando 1–20 de 57");
    expect(invoiceRangeText(3, 20, 57, 17)).toBe("Mostrando 41–57 de 57");
  });
});
