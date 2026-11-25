import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountPesosFromText,
  invoiceMismatches,
  invoiceFactsFromAttributes,
  pickGroup,
  pickOrganization,
  redact,
  type ApiInvoice,
  type ExpectedInvoice,
  type SelectOption,
} from "./matching.ts";

const expected: ExpectedInvoice = {
  businessId: "F-1",
  supplierName: "Proveedor Uno",
  amountPesos: "320.000",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  organizationId: "org-1",
  groupId: null,
};

const item: ApiInvoice = {
  id: "inv-1",
  businessId: "F-1",
  supplierName: "Proveedor Uno",
  amountPesos: 320000,
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  organizationId: "org-1",
  groupId: null,
};

test("amountPesosFromText reads plain, grouped and $-prefixed amounts", () => {
  assert.equal(amountPesosFromText("12500"), 12500);
  assert.equal(amountPesosFromText("320.000"), 320000);
  assert.equal(amountPesosFromText(" $ 1.234.567 "), 1234567);
  assert.equal(amountPesosFromText("12500,5"), undefined);
  assert.equal(amountPesosFromText("12.50"), undefined);
  assert.equal(amountPesosFromText("abc"), undefined);
  assert.equal(amountPesosFromText(""), undefined);
});

test("invoiceMismatches is empty when the invoice is what the row asked for", () => {
  assert.deepEqual(invoiceMismatches(expected, item), []);
  assert.deepEqual(
    invoiceMismatches({ ...expected, supplierName: "  Proveedor Uno " }, item),
    [],
  );
});

test("invoiceMismatches names every field that differs", () => {
  assert.deepEqual(
    invoiceMismatches(expected, {
      ...item,
      supplierName: "Otro",
      amountPesos: 1,
      issuedOn: "2026-01-01",
      dueOn: "2026-02-02",
      businessId: "F-2",
      organizationId: "org-2",
      groupId: "grp-1",
    }),
    [
      "businessId",
      "supplierName",
      "amountPesos",
      "issuedOn",
      "dueOn",
      "organizationId",
      "groupId",
    ],
  );
});

test("an amount that does not parse is a mismatch, and scope is skipped when unknown", () => {
  assert.deepEqual(
    invoiceMismatches({ ...expected, amountPesos: "12500,5" }, item),
    ["amountPesos"],
  );
  const noScope: ExpectedInvoice = {
    businessId: expected.businessId,
    supplierName: expected.supplierName,
    amountPesos: expected.amountPesos,
    issuedOn: expected.issuedOn,
    dueOn: expected.dueOn,
  };
  assert.deepEqual(
    invoiceMismatches(noScope, { ...item, organizationId: "x", groupId: "y" }),
    [],
  );
});

test("a group scope needs the same group id", () => {
  assert.deepEqual(invoiceMismatches({ ...expected, groupId: "grp-1" }, item), [
    "groupId",
  ]);
  assert.deepEqual(
    invoiceMismatches(
      { ...expected, groupId: "grp-1" },
      {
        ...item,
        groupId: "grp-1",
      },
    ),
    [],
  );
});

const attributes = {
  "data-business-id": "F-1",
  "data-supplier": 'Café "El Ñandú" & Cía',
  "data-amount-pesos": "320000",
  "data-issued-on": "2026-01-31",
  "data-due-on": "2026-02-28",
  "data-organization-id": "org-1",
  "data-group-id": "",
};

test("invoiceFactsFromAttributes reads the row anchors as typed facts", () => {
  assert.deepEqual(invoiceFactsFromAttributes(attributes), {
    businessId: "F-1",
    supplierName: 'Café "El Ñandú" & Cía',
    amountPesos: 320000,
    issuedOn: "2026-01-31",
    dueOn: "2026-02-28",
    organizationId: "org-1",
    groupId: null,
  });
  assert.equal(
    invoiceFactsFromAttributes({ ...attributes, "data-group-id": "grp-1" })
      ?.groupId,
    "grp-1",
  );
  assert.equal(
    invoiceFactsFromAttributes({ ...attributes, "data-amount-pesos": "0" })
      ?.amountPesos,
    0,
  );
});

test("invoiceFactsFromAttributes is undefined when an anchor is missing or malformed", () => {
  for (const name of Object.keys(attributes))
    assert.equal(
      invoiceFactsFromAttributes({ ...attributes, [name]: null }),
      undefined,
      name,
    );
  for (const amount of ["", "1.234", "12,5", "-1", "abc", " 5"])
    assert.equal(
      invoiceFactsFromAttributes({
        ...attributes,
        "data-amount-pesos": amount,
      }),
      undefined,
      amount,
    );
});

test("DOM facts feed invoiceMismatches like the API item did", () => {
  const facts = invoiceFactsFromAttributes(attributes)!;
  const row: ExpectedInvoice = {
    ...expected,
    supplierName: 'Café "El Ñandú" & Cía',
    issuedOn: "2026-01-31",
    dueOn: "2026-02-28",
  };
  assert.deepEqual(invoiceMismatches(row, facts), []);
  assert.deepEqual(invoiceMismatches({ ...row, dueOn: "2026-03-01" }, facts), [
    "dueOn",
  ]);
});

const option = (value: string, text: string): SelectOption => ({
  value,
  text,
});

const orgs = [option("o1", "Org Uno"), option("o2", "Org Dos")];
const groups = [
  option("organization:o1", "Sin grupo asignado"),
  option("group:o1:g1", "Compras"),
];

test("pickOrganization resolves an exact name and rejects unknown ones", () => {
  assert.deepEqual(pickOrganization(orgs, "Org Dos"), {
    kind: "found",
    choice: "o2",
  });
  assert.deepEqual(pickOrganization(orgs, " Org Dos "), {
    kind: "found",
    choice: "o2",
  });
  assert.deepEqual(pickOrganization(orgs, "Org"), { kind: "missing" });
  assert.deepEqual(pickOrganization(orgs, "org uno"), { kind: "missing" });
});

test("a blank organization uses the only offered one, else it is ambiguous", () => {
  assert.deepEqual(pickOrganization([option("o1", "Org Uno")], ""), {
    kind: "found",
    choice: "o1",
  });
  assert.deepEqual(pickOrganization(orgs, ""), { kind: "ambiguous" });
  assert.deepEqual(pickOrganization([], ""), { kind: "missing" });
});

test("two organizations sharing the wanted name are ambiguous, never the first", () => {
  const twins = [option("o1", "Acme"), option("o2", "Acme")];
  assert.deepEqual(pickOrganization(twins, "Acme"), { kind: "ambiguous" });
});

test("pickGroup resolves a named group and the blank organization scope", () => {
  assert.deepEqual(pickGroup(groups, "Compras"), {
    kind: "found",
    choice: { value: "group:o1:g1", organizationId: "o1", groupId: "g1" },
  });
  assert.deepEqual(pickGroup(groups, ""), {
    kind: "found",
    choice: { value: "organization:o1", organizationId: "o1" },
  });
  assert.deepEqual(pickGroup(groups, "Nada"), { kind: "missing" });
  assert.deepEqual(pickGroup(groups, "Sin grupo asignado"), {
    kind: "missing",
  });
  assert.deepEqual(pickGroup([option("group:o1:g1", "Compras")], ""), {
    kind: "missing",
  });
});

test("two groups sharing the wanted name are ambiguous, never the first", () => {
  const twins = [...groups, option("group:o1:g2", "Compras")];
  assert.deepEqual(pickGroup(twins, "Compras"), { kind: "ambiguous" });
  assert.deepEqual(pickGroup(twins, "").kind, "found");
});

test("redact removes every secret and caps the length", () => {
  const text = redact(`fill("pw") 11111111-1 pw\nsecond line`, [
    "pw",
    "11111111-1",
    "",
  ]);
  assert.equal(text.includes("pw"), false);
  assert.equal(text.includes("11111111-1"), false);
  assert.equal(text.includes("\n"), false);
  assert.equal(redact("x".repeat(1_000), []).length <= 300, true);
});
