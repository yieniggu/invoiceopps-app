import { describe, expect, it } from "vitest";

import { uuid } from "../../test/ids";
import type { Profile } from "../auth/types";
import { NO_PERMISSIONS, type InvoicePermissions } from "../permissions/types";
import { canDeleteInvoiceFromProfile } from "./invoiceDeletion";

const ME = uuid(1);
const norte = { id: uuid(101), name: "Norte", slug: "norte" };
const sur = { id: uuid(102), name: "Sur", slug: "sur" };
const contabilidad = { id: uuid(201), name: "Contabilidad" };
const compras = { id: uuid(202), name: "Compras" };

const OWN = { ...NO_PERMISSIONS, deleteOwnInvoices: true };
const OTHERS = { ...NO_PERMISSIONS, deleteOthersInvoices: true };

function profile(
  permissions: InvoicePermissions,
  groups: Array<{
    id: string;
    name: string;
    effective: InvoicePermissions;
  }> = [],
): Pick<Profile, "id" | "memberships"> {
  return {
    id: ME,
    memberships: [
      {
        organization: norte,
        role: "USER",
        permissions,
        groups: groups.map(({ effective, ...group }) => ({
          group,
          permissions: effective,
          effective,
        })),
      },
    ],
  };
}

const mine = { createdByUserId: ME, organizationId: norte.id };
const theirs = { createdByUserId: uuid(9000), organizationId: norte.id };
const inGroup = (base: typeof mine, groupId: string) => ({ ...base, groupId });
const orgScope = (base: typeof mine) => ({ ...base, groupId: null });

describe("canDeleteInvoiceFromProfile", () => {
  it("organization scope uses only the organization flags, by author", () => {
    expect(canDeleteInvoiceFromProfile(profile(OWN), orgScope(mine))).toBe(
      true,
    );
    expect(canDeleteInvoiceFromProfile(profile(OWN), orgScope(theirs))).toBe(
      false,
    );
    expect(canDeleteInvoiceFromProfile(profile(OTHERS), orgScope(theirs))).toBe(
      true,
    );
    expect(canDeleteInvoiceFromProfile(profile(OTHERS), orgScope(mine))).toBe(
      false,
    );
    expect(
      canDeleteInvoiceFromProfile(
        profile(NO_PERMISSIONS, [
          { ...contabilidad, effective: { ...OWN, ...OTHERS } },
        ]),
        orgScope(mine),
      ),
    ).toBe(false);
  });

  it("group invoice: group effective flags apply to a group member", () => {
    const member = profile(NO_PERMISSIONS, [
      { ...contabilidad, effective: OWN },
    ]);
    expect(
      canDeleteInvoiceFromProfile(member, inGroup(mine, contabilidad.id)),
    ).toBe(true);
    expect(
      canDeleteInvoiceFromProfile(member, inGroup(theirs, contabilidad.id)),
    ).toBe(false);
    const others = profile(NO_PERMISSIONS, [
      { ...contabilidad, effective: OTHERS },
    ]);
    expect(
      canDeleteInvoiceFromProfile(others, inGroup(theirs, contabilidad.id)),
    ).toBe(true);
    expect(
      canDeleteInvoiceFromProfile(others, inGroup(mine, contabilidad.id)),
    ).toBe(false);
  });

  it("group invoice: organization flags also apply (org OR group)", () => {
    const orgOnly = profile(OTHERS, [
      { ...contabilidad, effective: NO_PERMISSIONS },
    ]);
    expect(
      canDeleteInvoiceFromProfile(orgOnly, inGroup(theirs, contabilidad.id)),
    ).toBe(true);
  });

  it("a group the person is not a member of falls back to the organization flags", () => {
    const withOrg = profile(OWN, [{ ...compras, effective: NO_PERMISSIONS }]);
    expect(
      canDeleteInvoiceFromProfile(withOrg, inGroup(mine, contabilidad.id)),
    ).toBe(true);
    const without = profile(NO_PERMISSIONS, [
      { ...compras, effective: { ...OWN, ...OTHERS } },
    ]);
    expect(
      canDeleteInvoiceFromProfile(without, inGroup(mine, contabilidad.id)),
    ).toBe(false);
  });

  it("another group's flags never leak into this invoice", () => {
    const other = profile(NO_PERMISSIONS, [
      { ...compras, effective: { ...OWN, ...OTHERS } },
      { ...contabilidad, effective: NO_PERMISSIONS },
    ]);
    expect(
      canDeleteInvoiceFromProfile(other, inGroup(mine, contabilidad.id)),
    ).toBe(false);
  });

  it("read access is irrelevant, and an organization without membership offers nothing", () => {
    const readOnly = profile({ ...NO_PERMISSIONS, readInvoices: true });
    expect(canDeleteInvoiceFromProfile(readOnly, orgScope(mine))).toBe(false);
    const noRead = profile({ ...OWN, readInvoices: false });
    expect(canDeleteInvoiceFromProfile(noRead, orgScope(mine))).toBe(true);
    expect(
      canDeleteInvoiceFromProfile(profile(OWN), {
        ...orgScope(mine),
        organizationId: sur.id,
      }),
    ).toBe(false);
  });
});
