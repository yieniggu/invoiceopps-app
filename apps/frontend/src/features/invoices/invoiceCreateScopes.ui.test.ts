import { describe, expect, it } from "vitest";

import { NO_PERMISSIONS } from "../permissions/types";
import {
  compras,
  contabilidad,
  finanzas,
  norte,
  sur,
} from "../../test/invoices";
import { createScopeOptions, hasCreateAccess } from "./invoiceCreateScopes";

const CREATE = { ...NO_PERMISSIONS, createInvoices: true };
const READ = { ...NO_PERMISSIONS, readInvoices: true };

const profile = (
  memberships: Parameters<typeof createScopeOptions>[0]["memberships"],
) => ({ memberships });

const membership = (
  organization: { id: string; name: string },
  permissions: typeof CREATE,
  groups: Array<{
    group: { id: string; name: string };
    effective: typeof CREATE;
  }> = [],
) => ({
  organization: { ...organization, slug: organization.id },
  role: "USER",
  permissions,
  groups: groups.map(({ group, effective }) => ({
    group,
    permissions: effective,
    effective,
  })),
});

describe("createScopeOptions", () => {
  it("offers the organization and its groups to an organization-wide creator", () => {
    const options = createScopeOptions(
      profile([
        membership(norte, CREATE, [{ group: contabilidad, effective: CREATE }]),
      ]),
    );
    expect(
      options.map(({ label, groupId, organizationId }) => [
        label,
        groupId,
        organizationId,
      ]),
    ).toEqual([
      ["Organización (sin grupo)", null, norte.id],
      ["Contabilidad", contabilidad.id, norte.id],
    ]);
  });

  it("offers only the groups with effective create when the organization does not create", () => {
    const options = createScopeOptions(
      profile([
        membership(norte, NO_PERMISSIONS, [
          { group: contabilidad, effective: CREATE },
          { group: compras, effective: READ },
        ]),
      ]),
    );
    expect(options.map(({ label }) => label)).toEqual(["Contabilidad"]);
  });

  it("adds the groups the organization lists, deduplicated, for an organization creator only", () => {
    const listed = new Map([
      [norte.id, [contabilidad, finanzas]],
      [sur.id, [compras]],
    ]);
    const options = createScopeOptions(
      profile([
        membership(norte, CREATE, [{ group: contabilidad, effective: CREATE }]),
        membership(sur, READ),
      ]),
      listed,
    );
    expect(options.map(({ label }) => label)).toEqual([
      "Organización (sin grupo)",
      "Contabilidad",
      "Finanzas",
    ]);
  });

  it("flags whether the person can also read the scope", () => {
    const options = createScopeOptions(
      profile([
        membership(norte, { ...CREATE, readInvoices: true }),
        membership(sur, CREATE, [
          { group: compras, effective: { ...CREATE, readInvoices: true } },
        ]),
      ]),
    );
    expect(options.map(({ label, canRead }) => [label, canRead])).toEqual([
      ["Organización (sin grupo)", true],
      ["Organización (sin grupo)", false],
      ["Compras", true],
    ]);
  });

  it("offers nothing without create", () => {
    const only = profile([
      membership(norte, READ, [{ group: contabilidad, effective: READ }]),
    ]);
    expect(createScopeOptions(only)).toEqual([]);
    expect(hasCreateAccess(only)).toBe(false);
  });
});

describe("hasCreateAccess", () => {
  it("is true with organization create or a group with effective create", () => {
    expect(hasCreateAccess(profile([membership(norte, CREATE)]))).toBe(true);
    expect(
      hasCreateAccess(
        profile([
          membership(norte, NO_PERMISSIONS, [
            { group: compras, effective: CREATE },
          ]),
        ]),
      ),
    ).toBe(true);
  });
});
