import { describe, expect, it } from "vitest";

import {
  membership,
  NO_PERMISSIONS,
  profileFixture,
} from "../../test/transport";
import { uuid } from "../../test/ids";
import type { Profile } from "../auth/types";
import {
  retainAllowed,
  tokenScopeOptions,
  tokenStatus,
} from "./apiTokenScopes";
import { MAX_EXPIRY_DAYS, resolveExpiry, expiryBounds } from "./apiTokenExpiry";

const norte = { id: uuid(101), name: "Academia Norte" };
const sur = { id: uuid(102), name: "Instituto Sur" };
const contabilidad = { id: uuid(201), name: "Contabilidad" };
const compras = { id: uuid(202), name: "Compras" };
const finanzas = { id: uuid(203), name: "Finanzas" };

const flags = (...on: Array<keyof typeof NO_PERMISSIONS>) => ({
  ...NO_PERMISSIONS,
  ...Object.fromEntries(on.map((flag) => [flag, true])),
});

const profile = profileFixture({
  memberships: [
    membership(norte, "USER", {
      permissions: flags("readInvoices", "createInvoices"),
      groups: [
        {
          group: contabilidad,
          effective: flags("readInvoices", "deleteOwnInvoices"),
        },
      ],
    }),
    membership(sur, "USER", {
      groups: [{ group: compras, effective: flags("readInvoices") }],
    }),
  ],
}) as unknown as Profile;

describe("tokenScopeOptions", () => {
  it("offers organization and group scopes grouped per organization", () => {
    const options = tokenScopeOptions(
      profile,
      new Map([[norte.id, [contabilidad, finanzas]]]),
    );
    expect(
      options.map(({ organizationName, label, groupId }) => [
        organizationName,
        label,
        groupId,
      ]),
    ).toEqual([
      [norte.name, "Toda la organización", null],
      [norte.name, "Contabilidad", contabilidad.id],
      [norte.name, "Finanzas", finanzas.id],
      [sur.name, "Compras", compras.id],
    ]);
  });

  it("limits organization tokens to organization flags", () => {
    const [organization] = tokenScopeOptions(profile);
    expect(organization.allowed).toEqual(["invoices:read", "invoices:create"]);
  });

  it("limits group tokens to organization OR group effective flags", () => {
    const options = tokenScopeOptions(
      profile,
      new Map([[norte.id, [contabilidad, finanzas]]]),
    );
    const byGroup = (id: string) =>
      options.find(({ groupId }) => groupId === id)?.allowed;
    // Contabilidad: org read+create joined with its own read+delete-own.
    expect(byGroup(contabilidad.id)).toEqual([
      "invoices:read",
      "invoices:create",
      "invoices:delete-own",
    ]);
    // Finanzas is only reachable through the organization flags.
    expect(byGroup(finanzas.id)).toEqual(["invoices:read", "invoices:create"]);
    expect(byGroup(compras.id)).toEqual(["invoices:read"]);
  });

  it("skips scopes without any effective invoice permission", () => {
    const none = profileFixture({
      memberships: [
        membership(norte, "ADMIN", {
          groups: [{ group: contabilidad, effective: NO_PERMISSIONS }],
        }),
      ],
    }) as unknown as Profile;
    expect(tokenScopeOptions(none)).toEqual([]);
  });
});

describe("retainAllowed", () => {
  it("drops the scopes the new scope does not allow", () => {
    expect(
      retainAllowed(
        ["invoices:read", "invoices:delete-own", "invoices:create"],
        ["invoices:read", "invoices:create"],
      ),
    ).toEqual(["invoices:read", "invoices:create"]);
  });
});

describe("tokenStatus", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");
  const base = {
    expiresAt: "2026-11-05T12:00:00.000Z",
    revokedAt: null,
  };
  it("tells active, expired and revoked apart (revoked wins)", () => {
    expect(tokenStatus(base, now)).toBe("Activo");
    expect(
      tokenStatus({ ...base, expiresAt: "2026-10-31T12:00:00.000Z" }, now),
    ).toBe("Vencido");
    expect(
      tokenStatus({ ...base, revokedAt: "2026-10-30T12:00:00.000Z" }, now),
    ).toBe("Revocado");
    expect(
      tokenStatus(
        {
          expiresAt: "2026-10-01T12:00:00.000Z",
          revokedAt: "2026-10-02T12:00:00.000Z",
        },
        now,
      ),
    ).toBe("Revocado");
  });
});

describe("resolveExpiry", () => {
  const now = new Date(2026, 9, 31, 12, 0, 0);
  const DAY = 86_400_000;

  it("computes the 7 and 29 day presets inside the server limit", () => {
    const seven = resolveExpiry({ choice: "7", date: "" }, now);
    const thirty = resolveExpiry({ choice: "29", date: "" }, now);
    if (!("expiresAt" in seven) || !("expiresAt" in thirty))
      throw new Error("presets must resolve");
    expect(new Date(seven.expiresAt).getTime() - now.getTime()).toBe(7 * DAY);
    const remaining = new Date(thirty.expiresAt).getTime() - now.getTime();
    // A day short of the server's 30 absorbs a client clock that runs ahead.
    expect(remaining).toBe(MAX_EXPIRY_DAYS * DAY);
  });

  it("accepts a date up to 29 days ahead, never beyond the server limit", () => {
    const { max } = expiryBounds(now);
    const result = resolveExpiry({ choice: "custom", date: max }, now);
    if (!("expiresAt" in result)) throw new Error("max date must resolve");
    expect(
      new Date(result.expiresAt).getTime() - now.getTime(),
    ).toBeLessThanOrEqual(MAX_EXPIRY_DAYS * DAY);
  });

  it("rejects dates beyond 29 days, in the past, empty or malformed", () => {
    const { min, max } = expiryBounds(now);
    const after = new Date(now.getTime() + 30 * DAY);
    const civil = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect(max).toBe(civil(new Date(now.getTime() + 29 * DAY)));
    expect(min).toBe(civil(now));
    for (const date of [civil(after), "2026-10-30", "", "31-10-2026"]) {
      expect(resolveExpiry({ choice: "custom", date }, now)).toHaveProperty(
        "error",
      );
    }
  });
});
