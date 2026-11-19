import assert from "node:assert/strict";
import { test } from "node:test";

import type { Page } from "@playwright/test";

import { attrs, ids } from "./contract.ts";
import { InvoiceBatchBot, type BotOptions } from "./invoice-batch-bot.ts";
import type { BotRow } from "./excel.ts";

const row = (rowId: string): BotRow => ({
  rowId,
  organization: "",
  group: "",
  businessId: `RUN-${rowId}`,
  supplierName: "Proveedor",
  amountPesos: "12500",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  status: "",
});

const SECRET = "s3cret-pass";
const RUT = "11111111-1";

interface Script {
  /** 1-based submit click that throws (the row is in flight). */
  failOnSubmit?: number;
  /** 1-based fill of the business id that throws (nothing was submitted). */
  failOnFill?: number;
  failure?: Error;
  /** Every submit ends in an «uncertain» failure instead of success. */
  uncertain?: boolean;
  /** `goto` throws from this 1-based call on. */
  gotoFailsFrom?: number;
  /** Called on every submit click. */
  onSubmit?: (submits: number) => void;
  /** Dates typed into the issued-on field. */
  typedDates?: string[];
  /** The form reports this field as invalid after a submit (no request). */
  fieldError?: { id: string; field: string; message: string };
}

/**
 * A scripted page: every submit is a success, except what the script breaks
 * with what Playwright throws on a stuck page.
 */
function fakePage(script: Script = {}): Page {
  let submits = 0;
  let fills = 0;
  let gotos = 0;
  const options = [
    { value: "organization:org-1", text: "Org", organization: "Org" },
  ];
  const timeout = () =>
    Object.assign(new Error("Timeout 45000ms exceeded."), {
      name: "TimeoutError",
    });
  const locator = (key: string) => {
    const self = {
      fill: async (value: string) => {
        if (key === ids.businessId) {
          fills += 1;
          if (fills === script.failOnFill) throw script.failure ?? timeout();
        }
        if (key === ids.issuedOn) script.typedDates?.push(value);
      },
      selectOption: async () => {},
      waitFor: async () => {},
      textContent: async () =>
        key === `#${script.fieldError?.id}-error`
          ? (script.fieldError?.message ?? "")
          : "",
      first: () => self,
      evaluate: async () => (key === ids.scope ? options : []),
      count: async () => {
        if (script.fieldError) return key.includes("aria-invalid") ? 1 : 0;
        if (key === ids.created) return script.uncertain ? 0 : 1;
        if (key === ids.failure) return script.uncertain ? 1 : 0;
        return 0;
      },
      getAttribute: async (name: string) => {
        if (script.fieldError && name === "id") return script.fieldError.id;
        if (script.fieldError && name === attrs.field)
          return script.fieldError.field;
        return name === attrs.failureKind ? "uncertain" : `inv-${submits}`;
      },
      click: async () => {
        if (key !== ids.submit) return;
        submits += 1;
        script.onSubmit?.(submits);
        if (submits === script.failOnSubmit) throw script.failure ?? timeout();
      },
    };
    return self;
  };
  return {
    goto: async () => {
      gotos += 1;
      if (script.gotoFailsFrom && gotos >= script.gotoFailsFrom)
        throw new Error("Target page, context or browser has been closed");
      return null;
    },
    waitForTimeout: async () => {},
    waitForFunction: async () => ({ jsonValue: async () => "form" }),
    getByTestId: (id: string) => locator(id),
    locator: (selector: string) => locator(selector),
  } as unknown as Page;
}

const options = (page: Page, extra: Partial<BotOptions> = {}) =>
  new InvoiceBatchBot(page, {
    baseUrl: "http://127.0.0.1:5391",
    rut: RUT,
    password: SECRET,
    backoffMs: 1,
    ...extra,
  });

test("a crash after the submit click leaves that row UNCERTAIN and the later ones NOT_PROCESSED", async () => {
  const bot = options(fakePage({ failOnSubmit: 2 }));
  const outcomes = await bot.run([row("1"), row("2"), row("3")]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.rowId, outcome.result]),
    [
      ["1", "CREATED"],
      ["2", "UNCERTAIN"],
      ["3", "NOT_PROCESSED"],
    ],
  );
  assert.equal(outcomes[0]?.invoiceId, "inv-1");
  assert.equal(outcomes[1]?.errorKind, "crash");
  assert.equal(outcomes[1]?.attempts, 1);
  assert.equal(outcomes[2]?.errorKind, "crash");
  assert.match(outcomes[1]?.message ?? "", /Timeout 45000ms/);
  assert.equal(bot.abort?.kind, "crash");
});

test("a crash before the submit click leaves that row NOT_PROCESSED", async () => {
  const bot = options(fakePage({ failOnFill: 2 }));
  const outcomes = await bot.run([row("1"), row("2"), row("3")]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.result),
    ["CREATED", "NOT_PROCESSED", "NOT_PROCESSED"],
  );
  assert.equal(outcomes[1]?.errorKind, "crash");
  assert.equal(bot.abort?.kind, "crash");
});

test("the crash message never carries the credentials", async () => {
  const bot = options(
    fakePage({
      failOnSubmit: 1,
      failure: new Error(`fill("${SECRET}") failed for ${RUT}`),
    }),
  );
  const outcomes = await bot.run([row("1")]);
  const message = outcomes[0]?.message ?? "";
  assert.equal(message.includes(SECRET), false);
  assert.equal(message.includes(RUT), false);
  assert.equal(outcomes[0]?.result, "UNCERTAIN");
  assert.equal(outcomes[0]?.errorKind, "crash");
});

test("a batch that finished has no abort", async () => {
  const bot = options(fakePage());
  const outcomes = await bot.run([row("1"), row("2")]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.result),
    ["CREATED", "CREATED"],
  );
  assert.equal(bot.abort, undefined);
});

test("a crash while reconciling is an abort even though every row has an outcome", async () => {
  // Every submit ends «uncertain»; reconciliation then opens the inbox, which
  // fails (the first `goto` is the create form).
  const bot = options(fakePage({ uncertain: true, gotoFailsFrom: 2 }), {
    maxRetries: 0,
  });
  const outcomes = await bot.run([row("1")]);
  assert.equal(outcomes[0]?.result, "UNCERTAIN");
  assert.equal(
    outcomes.some((o) => o.result === "NOT_PROCESSED"),
    false,
  );
  assert.equal(bot.abort?.kind, "crash");
  assert.match(bot.abort?.message ?? "", /closed/);
});

test("a signal stops before the next row: the finished rows stay, the rest are NOT_PROCESSED", async () => {
  const stop = new AbortController();
  // The signal arrives right after row 1 is recorded, between two rows.
  const bot = options(fakePage(), {
    signal: stop.signal,
    log: (line) => {
      if (line.startsWith("1 CREATED")) stop.abort();
    },
  });
  const outcomes = await bot.run([row("1"), row("2"), row("3")]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.result),
    ["CREATED", "NOT_PROCESSED", "NOT_PROCESSED"],
  );
  assert.equal(outcomes[1]?.errorKind, "interrupted");
  assert.equal(bot.abort?.kind, "interrupted");
});

test("a signal while a row is being sent leaves that row UNCERTAIN", async () => {
  const stop = new AbortController();
  // The submit never settles: only the signal ends the wait.
  const page = fakePage({ onSubmit: () => stop.abort() });
  (page as unknown as { locator: unknown }).locator = () => ({
    first: () => ({ waitFor: () => new Promise(() => {}) }),
  });
  const bot = options(page, { signal: stop.signal });
  const outcomes = await bot.run([row("1"), row("2")]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.result, outcome.errorKind]),
    [
      ["UNCERTAIN", "interrupted"],
      ["NOT_PROCESSED", "interrupted"],
    ],
  );
});

test("an already aborted signal processes nothing", async () => {
  const stop = new AbortController();
  stop.abort();
  const bot = options(fakePage(), { signal: stop.signal });
  const outcomes = await bot.run([row("1")]);
  assert.equal(outcomes[0]?.result, "NOT_PROCESSED");
  assert.equal(outcomes[0]?.errorKind, "interrupted");
});

test("an impossible calendar date is typed as an empty field, never to `fill`", async () => {
  const typedDates: string[] = [];
  const bot = options(fakePage({ typedDates }));
  await bot.run([
    row("1"),
    { ...row("2"), issuedOn: "2026-02-31" },
    { ...row("3"), issuedOn: "31/02/2026" },
  ]);
  assert.deepEqual(typedDates, ["2026-10-25", "", ""]);
});

test("an impossible date ends REJECTED_FIELD on that field, without aborting the batch", async () => {
  const typedDates: string[] = [];
  const bot = options(
    fakePage({
      typedDates,
      // What the UI answers to the empty date: the field error, no request.
      fieldError: {
        id: "invoice-issued-on",
        field: "issuedOn",
        message: "La fecha de emisión es obligatoria",
      },
    }),
  );
  const outcomes = await bot.run([
    { ...row("1"), issuedOn: "2026-02-31" },
    { ...row("2"), issuedOn: "31/02/2026" },
  ]);
  assert.deepEqual(typedDates, ["", ""]);
  assert.deepEqual(
    outcomes.map((outcome) => [outcome.result, outcome.field]),
    [
      ["REJECTED_FIELD", "issuedOn"],
      ["REJECTED_FIELD", "issuedOn"],
    ],
  );
  assert.equal(bot.abort, undefined);
});

/** A page whose inbox shows one row with the given `data-*` anchors. */
function inboxPage(anchors: Record<string, string | null>): Page {
  const row = {
    count: async () => 1,
    first: () => row,
    getAttribute: async (name: string) =>
      name === "data-invoice-id" ? "inv-9" : (anchors[name] ?? null),
  };
  const results = {
    and: () => results,
    waitFor: async () => {},
    getAttribute: async () => "ready",
  };
  return {
    goto: async () => null,
    waitForFunction: async () => ({ jsonValue: async () => "row" }),
    locator: (selector: string) =>
      selector.includes("invoices-results") ? results : row,
  } as unknown as Page;
}

const rowAnchors = {
  "data-business-id": "RUN-1",
  "data-organization-id": "org-1",
  "data-group-id": "",
  "data-supplier": "Proveedor",
  "data-amount-pesos": "12500",
  "data-issued-on": "2026-10-25",
  "data-due-on": "2026-11-25",
};

type Lookup = {
  lookup(
    row: BotRow,
    scope: { value: string; organizationId: string },
  ): Promise<{ invoiceId: string; mismatches: string[] } | undefined>;
};
const lookup = (anchors: Record<string, string | null>) =>
  (options(inboxPage(anchors)) as unknown as Lookup).lookup(row("1"), {
    value: "organization:org-1",
    organizationId: "org-1",
  });

test("reconciliation compares the row data-* anchors, without any request", async () => {
  assert.deepEqual(await lookup(rowAnchors), {
    invoiceId: "inv-9",
    mismatches: [],
  });
  assert.deepEqual(
    (await lookup({ ...rowAnchors, "data-due-on": "2026-12-01" }))?.mismatches,
    ["dueOn"],
  );
  assert.deepEqual(
    (await lookup({ ...rowAnchors, "data-supplier": null }))?.mismatches,
    ["unverified"],
  );
});
