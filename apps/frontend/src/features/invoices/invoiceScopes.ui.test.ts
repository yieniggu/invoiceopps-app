import { describe, expect, it } from "vitest";

import type { Profile } from "../auth/types";
import { NO_PERMISSIONS } from "../permissions/types";
import { uuid } from "../../test/ids";
import {
  scopeFromSearch,
  scopeToSearch,
  defaultInvoiceScopeOption,
  hasInvoiceAccess,
  invoiceScopeOptions,
  resolveInvoiceScope,
} from "./invoiceScopes";
import { invoiceFiltersFromSearch, invoiceSearch } from "./invoiceFilters";

const READ = { ...NO_PERMISSIONS, readInvoices: true };
const CREATE_ONLY = { ...NO_PERMISSIONS, createInvoices: true };
const DELETE_OWN = { ...NO_PERMISSIONS, deleteOwnInvoices: true };

const norte = { id: uuid(1), name: "Academia Norte", slug: "norte" };
const sur = { id: uuid(2), name: "Instituto Sur", slug: "sur" };
const contabilidad = { id: uuid(11), name: "Contabilidad" };
const compras = { id: uuid(12), name: "Compras" };
const finanzas = { id: uuid(13), name: "Finanzas" };

function membershipOf(
  organization: typeof norte,
  permissions = NO_PERMISSIONS,
  groups: Array<{
    group: { id: string; name: string };
    effective: typeof READ;
  }> = [],
): Profile["memberships"][number] {
  return {
    organization,
    role: "USER",
    permissions,
    groups: groups.map(({ group, effective }) => ({
      group,
      permissions: effective,
      effective,
    })),
  };
}

const profileOf = (memberships: Profile["memberships"]) => ({ memberships });

describe("invoiceScopeOptions", () => {
  it("offers the whole organization, the ungrouped scope and every readable group", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, READ, [
          { group: contabilidad, effective: READ },
          { group: compras, effective: READ },
        ]),
      ]),
    );
    expect(options.map(({ label }) => label)).toEqual([
      "Toda la organización",
      "Sin grupo asignado",
      "Contabilidad",
      "Compras",
    ]);
    expect(options.map(({ context }) => context.kind)).toEqual([
      "organization",
      "ungrouped",
      "group",
      "group",
    ]);
  });

  it("offers only the readable groups when the organization has no read", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, NO_PERMISSIONS, [
          { group: contabilidad, effective: READ },
          { group: compras, effective: { ...NO_PERMISSIONS } },
        ]),
      ]),
    );
    expect(options.map(({ label }) => label)).toEqual(["Contabilidad"]);
  });

  it("reads the effective flags of a group, not its direct ones", () => {
    const options = invoiceScopeOptions(
      profileOf([
        {
          ...membershipOf(norte),
          groups: [
            {
              group: contabilidad,
              permissions: NO_PERMISSIONS,
              effective: READ,
            },
            { group: compras, permissions: READ, effective: NO_PERMISSIONS },
          ],
        },
      ]),
    );
    expect(options.map(({ label }) => label)).toEqual(["Contabilidad"]);
  });

  it("does not offer the organization scopes for create or delete flags alone", () => {
    expect(
      invoiceScopeOptions(
        profileOf([
          membershipOf(norte, CREATE_ONLY),
          membershipOf(sur, DELETE_OWN),
        ]),
      ),
    ).toEqual([]);
  });

  it("keeps labels short and names the organization apart when the person has several", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, READ),
        membershipOf(sur, NO_PERMISSIONS, [
          { group: contabilidad, effective: READ },
        ]),
      ]),
    );
    expect(
      options.map(
        ({ organizationName, label }) => `${organizationName} · ${label}`,
      ),
    ).toEqual([
      "Academia Norte · Toda la organización",
      "Academia Norte · Sin grupo asignado",
      "Instituto Sur · Contabilidad",
    ]);
  });

  it("describes each scope in words for the inbox subtitle and the empty state", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, READ, [{ group: contabilidad, effective: READ }]),
      ]),
    );
    expect(options.map(({ summary }) => summary)).toEqual([
      "Toda la organización · Academia Norte",
      "Sin grupo asignado · Academia Norte",
      "Grupo Contabilidad · Academia Norte",
    ]);
    expect(options.map(({ place }) => place)).toEqual([
      "Academia Norte",
      "Academia Norte sin grupo asignado",
      "el grupo Contabilidad",
    ]);
  });

  it("gives every option a distinct value", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, READ, [{ group: contabilidad, effective: READ }]),
        membershipOf(sur, READ, [{ group: contabilidad, effective: READ }]),
      ]),
    );
    expect(new Set(options.map(({ value }) => value)).size).toBe(
      options.length,
    );
  });

  it("is empty without memberships", () => {
    expect(invoiceScopeOptions(profileOf([]))).toEqual([]);
  });
});

describe("invoiceScopeOptions with the organization groups", () => {
  const orgGroups = (...groups: Array<{ id: string; name: string }>) =>
    new Map([[norte.id, groups]]);

  it("adds the groups the person is not a member of for organization read, without duplicating member groups", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, READ, [{ group: contabilidad, effective: READ }]),
      ]),
      orgGroups(compras, contabilidad, finanzas),
    );
    expect(options.map(({ label }) => label)).toEqual([
      "Toda la organización",
      "Sin grupo asignado",
      "Contabilidad",
      "Compras",
      "Finanzas",
    ]);
    expect(new Set(options.map(({ value }) => value)).size).toBe(5);
  });

  it("ignores the organization groups without organization read", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, NO_PERMISSIONS, [
          { group: contabilidad, effective: READ },
        ]),
      ]),
      orgGroups(compras, contabilidad, finanzas),
    );
    expect(options.map(({ label }) => label)).toEqual(["Contabilidad"]);
  });

  it("does not offer groups of another organization when there are several organizations", () => {
    const options = invoiceScopeOptions(
      profileOf([membershipOf(norte, READ), membershipOf(sur, READ)]),
      orgGroups(finanzas),
    );
    expect(
      options.map(
        ({ organizationName, label }) => `${organizationName} · ${label}`,
      ),
    ).toEqual([
      "Academia Norte · Toda la organización",
      "Academia Norte · Sin grupo asignado",
      "Academia Norte · Finanzas",
      "Instituto Sur · Toda la organización",
      "Instituto Sur · Sin grupo asignado",
    ]);
    expect(options.at(2)?.context).toEqual({
      kind: "group",
      organizationId: norte.id,
      groupId: finanzas.id,
    });
  });

  it("resolves a URL group of a non-member group only once the groups are known", () => {
    const profile = profileOf([membershipOf(norte, READ)]);
    const search = new URLSearchParams(
      `organizationId=${norte.id}&groupId=${finanzas.id}`,
    );
    expect(
      resolveInvoiceScope(invoiceScopeOptions(profile), search)?.context.kind,
    ).toBe("organization");
    expect(
      resolveInvoiceScope(
        invoiceScopeOptions(profile, orgGroups(finanzas)),
        search,
      )?.context,
    ).toEqual({
      kind: "group",
      organizationId: norte.id,
      groupId: finanzas.id,
    });
  });
});

describe("defaultInvoiceScopeOption", () => {
  it("prefers the first organization with organization read", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, NO_PERMISSIONS, [
          { group: contabilidad, effective: READ },
        ]),
        membershipOf(sur, READ),
      ]),
    );
    expect(defaultInvoiceScopeOption(options)?.context).toEqual({
      kind: "organization",
      organizationId: sur.id,
    });
  });

  it("falls back to the first readable group", () => {
    const options = invoiceScopeOptions(
      profileOf([
        membershipOf(norte, NO_PERMISSIONS, [
          { group: compras, effective: READ },
          { group: contabilidad, effective: READ },
        ]),
      ]),
    );
    expect(defaultInvoiceScopeOption(options)?.context).toEqual({
      kind: "group",
      organizationId: norte.id,
      groupId: compras.id,
    });
  });

  it("is undefined without options", () => {
    expect(defaultInvoiceScopeOption([])).toBeUndefined();
  });
});

describe("URL <-> context", () => {
  const options = invoiceScopeOptions(
    profileOf([
      membershipOf(norte, READ, [{ group: contabilidad, effective: READ }]),
      membershipOf(sur, NO_PERMISSIONS, [{ group: compras, effective: READ }]),
    ]),
  );

  it("round-trips every kind of context", () => {
    for (const { context } of options)
      expect(
        scopeFromSearch(new URLSearchParams(scopeToSearch(context))),
      ).toEqual(context);
  });

  it("writes ungrouped=true and no groupId for the ungrouped scope", () => {
    expect(
      scopeToSearch({ kind: "ungrouped", organizationId: norte.id }),
    ).toEqual([
      ["organizationId", norte.id],
      ["ungrouped", "true"],
    ]);
  });

  it("reads nothing from a malformed or contradictory URL", () => {
    expect(scopeFromSearch(new URLSearchParams())).toBeUndefined();
    expect(
      scopeFromSearch(new URLSearchParams("organizationId=nope")),
    ).toBeUndefined();
    expect(
      scopeFromSearch(
        new URLSearchParams(`organizationId=${norte.id}&groupId=nope`),
      ),
    ).toBeUndefined();
    expect(
      scopeFromSearch(
        new URLSearchParams(
          `organizationId=${norte.id}&groupId=${contabilidad.id}&ungrouped=true`,
        ),
      ),
    ).toBeUndefined();
  });

  it("resolves the URL context when it is one of the options", () => {
    const search = new URLSearchParams(
      `organizationId=${sur.id}&groupId=${compras.id}`,
    );
    expect(resolveInvoiceScope(options, search)?.context).toEqual({
      kind: "group",
      organizationId: sur.id,
      groupId: compras.id,
    });
  });

  it("uses the default when the URL has no context", () => {
    expect(
      resolveInvoiceScope(options, new URLSearchParams("page=2"))?.context,
    ).toEqual({ kind: "organization", organizationId: norte.id });
  });

  it("never resolves a context the person cannot read: it falls back to the default", () => {
    const forged = new URLSearchParams(`organizationId=${sur.id}`);
    expect(resolveInvoiceScope(options, forged)?.context).toEqual({
      kind: "organization",
      organizationId: norte.id,
    });
  });

  it("resolves nothing without options", () => {
    expect(
      resolveInvoiceScope(
        [],
        new URLSearchParams(`organizationId=${norte.id}`),
      ),
    ).toBeUndefined();
  });
});

describe("hasInvoiceAccess", () => {
  it.each([
    ["organization read", [membershipOf(norte, READ)]],
    ["organization create", [membershipOf(norte, CREATE_ONLY)]],
    ["organization delete own", [membershipOf(norte, DELETE_OWN)]],
    [
      "organization delete others",
      [membershipOf(norte, { ...NO_PERMISSIONS, deleteOthersInvoices: true })],
    ],
    [
      "an effective group flag",
      [
        membershipOf(norte, NO_PERMISSIONS, [
          { group: contabilidad, effective: CREATE_ONLY },
        ]),
      ],
    ],
    [
      "a flag in the second organization",
      [membershipOf(norte), membershipOf(sur, READ)],
    ],
  ])("is true with %s", (_name, memberships) => {
    expect(hasInvoiceAccess(profileOf(memberships))).toBe(true);
  });

  it("is false without any flag, whatever the role", () => {
    expect(hasInvoiceAccess(profileOf([]))).toBe(false);
    expect(
      hasInvoiceAccess(
        profileOf([
          {
            ...membershipOf(norte, NO_PERMISSIONS, [
              { group: contabilidad, effective: NO_PERMISSIONS },
            ]),
            role: "ADMIN",
          },
        ]),
      ),
    ).toBe(false);
  });
});

describe("filters in the URL", () => {
  const read = (search: string) =>
    invoiceFiltersFromSearch(new URLSearchParams(search));

  it("reads defaults from an empty URL", () => {
    expect(read("")).toEqual({ q: "", page: 1 });
  });

  it("reads status, dates, text and page", () => {
    expect(
      read(
        "businessStatus=APPROVED&issuedFrom=2026-01-02&issuedTo=2026-03-04&q=%20acme%20&page=3",
      ),
    ).toEqual({
      businessStatus: "APPROVED",
      issuedFrom: "2026-01-02",
      issuedTo: "2026-03-04",
      q: "acme",
      page: 3,
    });
  });

  it("drops invalid values instead of sending them to the API", () => {
    expect(
      read(
        "businessStatus=NOPE&issuedFrom=2026-13-45&issuedTo=ayer&q=" +
          "x".repeat(121) +
          "&page=0",
      ),
    ).toEqual({ q: "", page: 1 });
  });

  it("writes the context first and only non-default filters", () => {
    const context = { kind: "organization", organizationId: norte.id } as const;
    expect(invoiceSearch(context, { q: "", page: 1 })).toBe(
      `organizationId=${norte.id}`,
    );
    expect(
      invoiceSearch(
        { kind: "group", organizationId: norte.id, groupId: compras.id },
        {
          businessStatus: "PENDING",
          issuedFrom: "2026-01-01",
          issuedTo: "2026-02-01",
          q: "acme",
          page: 2,
        },
      ),
    ).toBe(
      `organizationId=${norte.id}&groupId=${compras.id}&businessStatus=PENDING&issuedFrom=2026-01-01&issuedTo=2026-02-01&q=acme&page=2`,
    );
  });
});
