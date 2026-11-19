import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDemoHeadless, parseDemoSlowMo } from "./demo-env.ts";

test("RPA_DEMO_HEADLESS accepts 1/0/true/false and defaults to headed", () => {
  assert.equal(parseDemoHeadless(undefined), false);
  assert.equal(parseDemoHeadless(""), false);
  for (const yes of ["1", "true", "TRUE"])
    assert.equal(parseDemoHeadless(yes), true, yes);
  for (const no of ["0", "false"])
    assert.equal(parseDemoHeadless(no), false, no);
});

test("RPA_DEMO_HEADLESS rejects anything else with a clear error", () => {
  assert.throws(() => parseDemoHeadless("yes"), /RPA_DEMO_HEADLESS/);
  assert.throws(() => parseDemoHeadless("2"), /RPA_DEMO_HEADLESS/);
});

test("RPA_DEMO_SLOWMO is a non-negative integer, with a default per mode", () => {
  assert.equal(parseDemoSlowMo(undefined, false), 250);
  assert.equal(parseDemoSlowMo(undefined, true), 0);
  assert.equal(parseDemoSlowMo("", true), 0);
  assert.equal(parseDemoSlowMo("600", false), 600);
  assert.equal(parseDemoSlowMo("0", false), 0);
});

test("RPA_DEMO_SLOWMO rejects negatives, decimals and text", () => {
  for (const bad of ["-1", "1.5", "abc", "1e3", " "])
    assert.throws(() => parseDemoSlowMo(bad, false), /RPA_DEMO_SLOWMO/, bad);
});
