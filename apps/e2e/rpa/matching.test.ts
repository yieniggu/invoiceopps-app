import assert from "node:assert/strict";
import { test } from "node:test";

import {
  amountPesosFromText,
  invoiceMismatches,
  invoiceFactsFromAttributes,
  pickScope,
  redact,
  type ApiInvoice,
  type ExpectedInvoice,
  type ScopeOption,
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

const option = (
  value: string,
  text: string,
  organization: string,
): ScopeOption => ({ value, text, organization });

const offered = [
  option("organization:o1", "Org Uno", "Org Uno"),
  option("group:o1:g1", "Compras", "Org Uno"),
];

test("pickScope resolves a named organization and group", () => {
  assert.deepEqual(pickScope(offered, "Org Uno", ""), {
    kind: "found",
    choice: { value: "organization:o1", organizationId: "o1" },
  });
  assert.deepEqual(pickScope(offered, "Org Uno", "Compras"), {
    kind: "found",
    choice: { value: "group:o1:g1", organizationId: "o1", groupId: "g1" },
  });
  assert.deepEqual(pickScope(offered, "Org Uno", "Nada"), {
    kind: "missing",
  });
  assert.deepEqual(pickScope(offered, "Otra", ""), { kind: "missing" });
});

test("a blank organization uses the only offered one", () => {
  assert.deepEqual(pickScope(offered, "", ""), {
    kind: "found",
    choice: { value: "organization:o1", organizationId: "o1" },
  });
});

test("a blank organization with several offered is ambiguous", () => {
  const several = [...offered, option("organization:o2", "Org Dos", "Org Dos")];
  assert.deepEqual(pickScope(several, "", ""), { kind: "ambiguous" });
  assert.deepEqual(pickScope(several, "", "Compras"), { kind: "ambiguous" });
  assert.deepEqual(pickScope(several, "Org Dos", ""), {
    kind: "found",
    choice: { value: "organization:o2", organizationId: "o2" },
  });
});

test("two organizations sharing the wanted label are ambiguous, never the first", () => {
  const twins = [
    option("organization:o1", "Acme", "Acme"),
    option("group:o1:g1", "Compras", "Acme"),
    option("organization:o2", "Acme", "Acme"),
    option("group:o2:g2", "Compras", "Acme"),
  ];
  assert.deepEqual(pickScope(twins, "Acme", ""), { kind: "ambiguous" });
  assert.deepEqual(pickScope(twins, "Acme", "Compras"), { kind: "ambiguous" });
  // One organization with several groups under the same label is not ambiguous.
  assert.deepEqual(pickScope(offered, "Org Uno", "Compras").kind, "found");
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
