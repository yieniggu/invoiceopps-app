import assert from "node:assert/strict";
import { test } from "node:test";

import { css, cssString } from "./contract.ts";

test("cssString escapes backslashes and quotes", () => {
  assert.equal(cssString('a\\b"c'), 'a\\\\b\\"c');
});

test("cssString escapes control characters and newlines as hex escapes", () => {
  assert.equal(cssString("a\nb"), "a\\a b");
  assert.equal(cssString("a\tb\u007f"), "a\\9 b\\7f ");
  assert.equal(cssString("a\u0000b"), "a�b");
});

test("invoiceRow builds an attribute selector that survives hostile ids", () => {
  assert.equal(
    css.invoiceRow('X\\"\n'),
    '[data-testid="invoices-row"][data-business-id="X\\\\\\"\\a "]',
  );
  assert.equal(
    css.invoiceRow("FAC-1"),
    '[data-testid="invoices-row"][data-business-id="FAC-1"]',
  );
});
